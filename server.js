const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'morse123';

const users = new Map();
const clients = new Map();
let clientCount = 0;
let bannedIPs = new Set();
let mutedClients = new Set();
let messageLog = [];

const countryCodes = {
    'US':'United States','GB':'United Kingdom','DE':'Germany','BR':'Brazil','JP':'Japan',
    'FR':'France','IT':'Italy','CA':'Canada','AU':'Australia','IN':'India',
    'RU':'Russia','CN':'China','KR':'South Korea','ES':'Spain','MX':'Mexico',
    'NL':'Netherlands','SE':'Sweden','NO':'Norway','DK':'Denmark','FI':'Finland',
    'PL':'Poland','UA':'Ukraine','TR':'Turkey','GR':'Greece','PT':'Portugal',
    'AR':'Argentina','CL':'Chile','CO':'Colombia','PE':'Peru','ZA':'South Africa',
    'EG':'Egypt','NG':'Nigeria','KE':'Kenya','MA':'Morocco','AE':'UAE',
    'SA':'Saudi Arabia','IL':'Israel','TH':'Thailand','VN':'Vietnam','PH':'Philippines',
    'MY':'Malaysia','ID':'Indonesia','NZ':'New Zealand','SG':'Singapore','PK':'Pakistan'
};

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('index.html not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/admin') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('admin.html not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });

const channels = {
    'CH1': { type: 'standard', minWPM: 5, maxWPM: 20 },
    'CH2': { type: 'standard', minWPM: 5, maxWPM: 20 },
    'CH3': { type: 'standard', minWPM: 5, maxWPM: 20 },
    'CH4': { type: 'standard', minWPM: 5, maxWPM: 20 },
    'CH5': { type: 'training', minWPM: 5, maxWPM: 10, showLetters: true },
    'CH6': { type: 'training', minWPM: 5, maxWPM: 10, showLetters: true },
    'CH7': { type: 'pro', minWPM: 20, maxWPM: 40, requireAuth: true, showLetters: false },
    'CH8': { type: 'pro', minWPM: 20, maxWPM: 40, requireAuth: true, showLetters: false }
};

function getClientsList() {
    const list = [];
    clients.forEach((data, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            list.push({
                id: data.id,
                username: data.username,
                callsign: data.callsign,
                channel: data.channel,
                isAdmin: data.isAdmin,
                muted: mutedClients.has(data.id),
                authenticated: data.authenticated,
                country: data.country
            });
        }
    });
    return list;
}

function getChannelUsers(ch) {
    return getClientsList().filter(c => c.channel === ch);
}

function broadcastToAll(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) try { c.send(str); } catch (e) {} });
}

function broadcastToChannel(channel, msg) {
    const str = JSON.stringify(msg);
    clients.forEach((data, ws) => {
        if (data.channel === channel && ws.readyState === WebSocket.OPEN) {
            try { ws.send(str); } catch (e) {}
        }
    });
}

function broadcastExcept(sender, msg) {
    const str = JSON.stringify(msg);
    const senderData = clients.get(sender);
    if (!senderData) return;
    clients.forEach((data, ws) => {
        if (ws !== sender && data.channel === senderData.channel && ws.readyState === WebSocket.OPEN) {
            try { ws.send(str); } catch (e) {}
        }
    });
}

function sendToClient(clientId, msg) {
    const str = JSON.stringify(msg);
    clients.forEach((data, ws) => {
        if (data.id === clientId && ws.readyState === WebSocket.OPEN) {
            try { ws.send(str); } catch (e) {}
        }
    });
}

function kickClient(clientId) {
    clients.forEach((data, ws) => {
        if (data.id === clientId) {
            try { ws.send(JSON.stringify({ type: 'kicked', text: 'Kicked by admin.' })); } catch (e) {}
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 500);
        }
    });
}

function banClient(clientId) {
    let ip = '';
    clients.forEach((data, ws) => {
        if (data.id === clientId) {
            ip = data.ip;
            try { ws.send(JSON.stringify({ type: 'banned', text: 'Banned.' })); } catch (e) {}
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 500);
        }
    });
    if (ip) bannedIPs.add(ip);
}

setInterval(() => {
    clients.forEach((data, ws) => {
        if (ws.readyState !== WebSocket.OPEN) { clients.delete(ws); mutedClients.delete(data.id); }
    });
}, 30000);

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const isLocalhost = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
    
    if (bannedIPs.has(ip) && !isLocalhost) {
        ws.send(JSON.stringify({ type: 'connection', state: 'banned', text: 'You are banned.' }));
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 1000);
        return;
    }
    
    const clientId = ++clientCount;
    const defaultName = isLocalhost ? 'ADMIN' : ('OP' + clientId);
    
    clients.set(ws, {
        id: clientId,
        username: defaultName,
        callsign: '',
        channel: 'CH1',
        ip: ip,
        isAdmin: isLocalhost,
        authenticated: isLocalhost,
        country: '',
        connectedAt: new Date().toISOString(),
        messageCount: 0
    });
    
    console.log(`📡 ${defaultName} (${clientId}) on CH1. ${clients.size} online.`);
    
    ws.send(JSON.stringify({
        type: 'connection',
        state: 'connected',
        clientId: clientId,
        username: defaultName,
        channel: 'CH1',
        isAdmin: isLocalhost,
        authenticated: isLocalhost,
        clients: getClientsList(),
        channelUsers: getChannelUsers('CH1'),
        channels: channels
    }));
    
    broadcastToChannel('CH1', {
        type: 'system',
        text: `${defaultName} joined CH1.`,
        channel: 'CH1'
    });
    
    broadcastToAll({ type: 'clientList', clients: getClientsList() });
    broadcastToChannel('CH1', { type: 'channelUsers', users: getChannelUsers('CH1') });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const clientData = clients.get(ws);
            if (!clientData) return;
            
            msg.from = clientId;
            msg.fromUsername = clientData.username;
            msg.fromCallsign = clientData.callsign;
            msg.channel = clientData.channel;
            msg.timestamp = Date.now();
            
            // REGISTER
            if (msg.type === 'register') {
                const { username, password, country, callsignSuffix } = msg;
                if (!username || !password || !country || !callsignSuffix) {
                    ws.send(JSON.stringify({ type: 'registerResult', success: false, text: 'All fields required.' }));
                    return;
                }
                if (users.has(username.toLowerCase())) {
                    ws.send(JSON.stringify({ type: 'registerResult', success: false, text: 'Username taken.' }));
                    return;
                }
                if (callsignSuffix.length !== 5) {
                    ws.send(JSON.stringify({ type: 'registerResult', success: false, text: 'Callsign suffix must be 5 characters.' }));
                    return;
                }
                const callsign = country.toUpperCase() + '-' + callsignSuffix.toUpperCase();
                users.set(username.toLowerCase(), { password, callsign, country: country.toUpperCase(), createdAt: new Date().toISOString() });
                clientData.username = username;
                clientData.callsign = callsign;
                clientData.authenticated = true;
                clientData.country = country;
                ws.send(JSON.stringify({ type: 'registerResult', success: true, callsign, username }));
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                broadcastToChannel(clientData.channel, { type: 'channelUsers', users: getChannelUsers(clientData.channel) });
                broadcastToChannel(clientData.channel, { type: 'system', text: `${username} (${callsign}) registered!`, channel: clientData.channel });
                return;
            }
            
            // LOGIN
            if (msg.type === 'login') {
                const { username, password } = msg;
                const user = users.get(username.toLowerCase());
                if (!user || user.password !== password) {
                    ws.send(JSON.stringify({ type: 'loginResult', success: false, text: 'Invalid credentials.' }));
                    return;
                }
                clientData.username = username;
                clientData.callsign = user.callsign;
                clientData.authenticated = true;
                clientData.country = user.country;
                ws.send(JSON.stringify({ type: 'loginResult', success: true, callsign: user.callsign, username }));
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                broadcastToChannel(clientData.channel, { type: 'channelUsers', users: getChannelUsers(clientData.channel) });
                broadcastToChannel(clientData.channel, { type: 'system', text: `${username} (${user.callsign}) logged in.`, channel: clientData.channel });
                return;
            }
            
            // JOIN CHANNEL
            if (msg.type === 'joinChannel') {
                const newCh = msg.channel;
                if (!channels[newCh]) {
                    ws.send(JSON.stringify({ type: 'system', text: 'Channel not found.', channel: clientData.channel }));
                    return;
                }
                if (newCh === clientData.channel) return;
                
                // Pro channel gate
                if (channels[newCh].requireAuth && !clientData.authenticated) {
                    ws.send(JSON.stringify({ type: 'connection', state: 'denied', text: 'Login required for Pro channels (CH7-CH8).', channel: newCh }));
                    return;
                }
                
                const oldCh = clientData.channel;
                clientData.channel = newCh;
                
                console.log(`🔄 ${clientData.username} switched from ${oldCh} to ${newCh}`);
                
                broadcastToChannel(oldCh, { type: 'system', text: `${clientData.username} left.`, channel: oldCh });
                broadcastToChannel(oldCh, { type: 'channelUsers', users: getChannelUsers(oldCh) });
                broadcastToChannel(newCh, { type: 'system', text: `${clientData.username} joined.`, channel: newCh });
                broadcastToChannel(newCh, { type: 'channelUsers', users: getChannelUsers(newCh) });
                ws.send(JSON.stringify({ type: 'channelChanged', channel: newCh, channelUsers: getChannelUsers(newCh) }));
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                return;
            }
            
            // Check muted
            if (mutedClients.has(clientId) && (msg.type === 'msg' || msg.type === 'morseMsg')) {
                ws.send(JSON.stringify({ type: 'system', text: 'You are muted.', channel: clientData.channel }));
                return;
            }
            
            // ADMIN COMMANDS
            if (msg.type === 'admin-login' && msg.password === ADMIN_PASSWORD) {
                ws.send(JSON.stringify({ type: 'admin-auth', success: true, clients: getClientsList(), log: messageLog.slice(-50), bannedIPs: Array.from(bannedIPs), channels }));
                return;
            }
            if (msg.type === 'admin-kick' && msg.adminPassword === ADMIN_PASSWORD) { kickClient(msg.targetId); broadcastToAll({ type: 'system', text: `User kicked.` }); return; }
            if (msg.type === 'admin-ban' && msg.adminPassword === ADMIN_PASSWORD) { banClient(msg.targetId); broadcastToAll({ type: 'system', text: `User banned.` }); return; }
            if (msg.type === 'admin-mute' && msg.adminPassword === ADMIN_PASSWORD) {
                if (mutedClients.has(msg.targetId)) { mutedClients.delete(msg.targetId); sendToClient(msg.targetId, { type: 'system', text: 'Unmuted.' }); }
                else { mutedClients.add(msg.targetId); sendToClient(msg.targetId, { type: 'system', text: 'Muted.' }); }
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                return;
            }
            if (msg.type === 'admin-broadcast' && msg.adminPassword === ADMIN_PASSWORD) { broadcastToAll({ type: 'system', text: `📢 ADMIN: ${msg.text}` }); return; }
            if (msg.type === 'admin-pm' && msg.adminPassword === ADMIN_PASSWORD) { sendToClient(msg.targetId, { type: 'pm', text: msg.text, from: 'ADMIN' }); return; }
            
            // Regular message
            clientData.messageCount++;
            messageLog.push({ from: clientId, username: clientData.username, callsign: clientData.callsign, channel: clientData.channel, type: msg.type, text: msg.text || '', morse: msg.morse || '', time: new Date().toISOString() });
            if (messageLog.length > 200) messageLog.shift();
            
            console.log(`📨 [${clientData.channel}] ${clientData.username}: ${msg.text || msg.morse || msg.type}`);
            broadcastExcept(ws, msg);
            
        } catch (e) { console.log('Error:', e.message); }
    });
    
    ws.on('close', () => {
        const clientData = clients.get(ws);
        const name = clientData?.username || 'Unknown';
        const ch = clientData?.channel || 'CH1';
        clients.delete(ws);
        mutedClients.delete(clientId);
        broadcastToChannel(ch, { type: 'system', text: `${name} left.`, channel: ch });
        broadcastToChannel(ch, { type: 'channelUsers', users: getChannelUsers(ch) });
        broadcastToAll({ type: 'clientList', clients: getClientsList() });
    });
    
    ws.on('error', () => { clients.delete(ws); mutedClients.delete(clientId); });
});

server.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('  📻 MORSE CENTER v3');
    console.log('═══════════════════════════════════');
    console.log(`  Local: http://localhost:${PORT}`);
    console.log(`  Admin: http://localhost:${PORT}/admin`);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`  Network: http://${iface.address}:${PORT}`);
            }
        }
    }
    console.log(`  Admin Password: ${ADMIN_PASSWORD}`);
    console.log('  8 Channels | Login/Register | Pro Gate');
    console.log('  Press Ctrl+C to stop');
    console.log('═══════════════════════════════════');
});
