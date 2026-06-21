const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'morse123';
const clients = new Map();
let clientCount = 0;
let bannedIPs = new Set();
let mutedClients = new Set();
let messageLog = [];

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('index.html not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/admin') {
        const filePath = path.join(__dirname, 'admin.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('admin.html not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });

function getClientsList() {
    const list = [];
    clients.forEach((data, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            list.push({
                id: data.id,
                name: data.name,
                displayName: data.displayName,
                channel: data.channel,
                ip: data.isAdmin ? 'localhost' : data.ip,
                isAdmin: data.isAdmin,
                muted: mutedClients.has(data.id)
            });
        }
    });
    return list;
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
    const channel = senderData ? senderData.channel : null;
    if (!channel) return;
    clients.forEach((data, ws) => {
        if (ws !== sender && data.channel === channel && ws.readyState === WebSocket.OPEN) {
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
        ws.send(JSON.stringify({ type: 'banned', text: 'Banned.' }));
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 1000);
        return;
    }
    
    const clientId = ++clientCount;
    const defaultName = isLocalhost ? 'ADMIN' : ('Operator_' + clientId);
    
    clients.set(ws, {
        id: clientId,
        name: defaultName,
        displayName: defaultName,
        channel: 'CH1',
        ip: ip,
        isAdmin: isLocalhost,
        connectedAt: new Date().toISOString(),
        messageCount: 0
    });
    
    console.log(`📡 ${defaultName} (${clientId}) on CH1. ${clients.size} online.`);
    
    ws.send(JSON.stringify({
        type: 'welcome',
        text: `Connected! Channel: CH1`,
        clientId: clientId,
        clientName: defaultName,
        channel: 'CH1',
        isAdmin: isLocalhost,
        clients: getClientsList()
    }));
    
    broadcastToChannel('CH1', {
        type: 'system',
        text: `${defaultName} joined CH1.`,
        channel: 'CH1'
    });
    
    broadcastToAll({ type: 'clientList', clients: getClientsList() });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const clientData = clients.get(ws);
            if (!clientData) return;
            
            msg.from = clientId;
            msg.fromName = clientData.displayName || clientData.name;
            msg.channel = clientData.channel;
            msg.timestamp = Date.now();
            
            if (msg.type === 'setName') {
                if (msg.name && msg.name.trim().length > 0 && msg.name.trim().length <= 20) {
                    const old = clientData.displayName;
                    clientData.name = msg.name.trim();
                    clientData.displayName = msg.name.trim();
                    broadcastToChannel(clientData.channel, { type: 'system', text: `${old} → ${clientData.displayName}`, channel: clientData.channel });
                    ws.send(JSON.stringify({ type: 'nameUpdated', name: clientData.displayName }));
                    broadcastToAll({ type: 'clientList', clients: getClientsList() });
                }
                return;
            }
            
            if (msg.type === 'joinChannel') {
                const newCh = msg.channel;
                if (['CH1','CH2','CH3','CH4'].includes(newCh) && newCh !== clientData.channel) {
                    const oldCh = clientData.channel;
                    clientData.channel = newCh;
                    broadcastToChannel(oldCh, { type: 'system', text: `${clientData.displayName} left ${oldCh}`, channel: oldCh });
                    broadcastToChannel(newCh, { type: 'system', text: `${clientData.displayName} joined ${newCh}`, channel: newCh });
                    ws.send(JSON.stringify({ type: 'channelChanged', channel: newCh }));
                    broadcastToAll({ type: 'clientList', clients: getClientsList() });
                }
                return;
            }
            
            if (mutedClients.has(clientId) && (msg.type === 'msg' || msg.type === 'test')) {
                ws.send(JSON.stringify({ type: 'system', text: 'You are muted.', channel: clientData.channel }));
                return;
            }
            
            // ADMIN COMMANDS
            if (msg.type === 'admin-login' && msg.password === ADMIN_PASSWORD) {
                ws.send(JSON.stringify({ type: 'admin-auth', success: true, clients: getClientsList(), log: messageLog.slice(-50), bannedIPs: Array.from(bannedIPs) }));
                return;
            }
            if (msg.type === 'admin-kick' && msg.adminPassword === ADMIN_PASSWORD) { kickClient(msg.targetId); broadcastToAll({ type: 'system', text: `Client ${msg.targetId} kicked.` }); return; }
            if (msg.type === 'admin-ban' && msg.adminPassword === ADMIN_PASSWORD) { banClient(msg.targetId); broadcastToAll({ type: 'system', text: `Client ${msg.targetId} banned.` }); return; }
            if (msg.type === 'admin-mute' && msg.adminPassword === ADMIN_PASSWORD) {
                if (mutedClients.has(msg.targetId)) { mutedClients.delete(msg.targetId); sendToClient(msg.targetId, { type: 'system', text: 'Unmuted.' }); }
                else { mutedClients.add(msg.targetId); sendToClient(msg.targetId, { type: 'system', text: 'Muted.' }); }
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                return;
            }
            if (msg.type === 'admin-broadcast' && msg.adminPassword === ADMIN_PASSWORD) { broadcastToAll({ type: 'system', text: `📢 ADMIN: ${msg.text}` }); return; }
            if (msg.type === 'admin-pm' && msg.adminPassword === ADMIN_PASSWORD) { sendToClient(msg.targetId, { type: 'pm', text: msg.text, from: 'ADMIN' }); return; }
            if (msg.type === 'admin-unban' && msg.adminPassword === ADMIN_PASSWORD) { bannedIPs.delete(msg.ip); broadcastToAll({ type: 'system', text: `IP ${msg.ip} unbanned.` }); return; }
            
            // Regular message
            clientData.messageCount++;
            messageLog.push({ from: clientId, fromName: clientData.displayName, channel: clientData.channel, type: msg.type, text: msg.text || '', time: new Date().toISOString() });
            if (messageLog.length > 200) messageLog.shift();
            
            console.log(`📨 [${clientData.channel}] ${clientData.displayName}: ${msg.text || msg.type}`);
            broadcastExcept(ws, msg);
            
        } catch (e) { console.log('Error:', e.message); }
    });
    
    ws.on('close', () => {
        const clientData = clients.get(ws);
        const name = clientData?.displayName || 'Unknown';
        const ch = clientData?.channel || 'CH1';
        clients.delete(ws);
        mutedClients.delete(clientId);
        broadcastToChannel(ch, { type: 'system', text: `${name} left ${ch}.`, channel: ch });
        broadcastToAll({ type: 'clientList', clients: getClientsList() });
    });
    
    ws.on('error', () => { clients.delete(ws); mutedClients.delete(clientId); });
});

server.listen(PORT, () => {
    console.log('📻 Morse Server with Channels on port', PORT);
});
