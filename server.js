const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const PORT = 3000;
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
                ip: data.isAdmin ? 'localhost' : data.ip,
                isAdmin: data.isAdmin,
                connectedAt: data.connectedAt,
                muted: mutedClients.has(data.id),
                messages: data.messageCount
            });
        }
    });
    return list;
}

function broadcastToAll(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            try { c.send(str); } catch (e) {}
        }
    });
}

function broadcastExcept(sender, msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c !== sender && c.readyState === WebSocket.OPEN) {
            try { c.send(str); } catch (e) {}
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
            try { ws.send(JSON.stringify({ type: 'kicked', text: 'You have been kicked by the admin.' })); } catch (e) {}
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 500);
        }
    });
}

function banClient(clientId) {
    let ip = '';
    clients.forEach((data, ws) => {
        if (data.id === clientId) {
            ip = data.ip;
            try { ws.send(JSON.stringify({ type: 'banned', text: 'You have been banned.' })); } catch (e) {}
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 500);
        }
    });
    if (ip) bannedIPs.add(ip);
}

// Clean up dead connections periodically
setInterval(() => {
    clients.forEach((data, ws) => {
        if (ws.readyState !== WebSocket.OPEN) {
            clients.delete(ws);
            mutedClients.delete(data.id);
        }
    });
}, 30000);

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const isLocalhost = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
    
    if (bannedIPs.has(ip) && !isLocalhost) {
        ws.send(JSON.stringify({ type: 'banned', text: 'You are banned from this server.' }));
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 1000);
        return;
    }
    
    const clientId = ++clientCount;
    const defaultName = isLocalhost ? 'ADMIN' : ('Operator_' + clientId);
    
    clients.set(ws, {
        id: clientId,
        name: defaultName,
        displayName: defaultName,
        ip: ip,
        isAdmin: isLocalhost,
        connectedAt: new Date().toISOString(),
        messageCount: 0
    });
    
    console.log(`📡 ${defaultName} (${clientId}) connected. ${clients.size} online.`);
    
    ws.send(JSON.stringify({
        type: 'welcome',
        text: `Connected! ${clients.size} client(s) online.`,
        clientId: clientId,
        clientName: defaultName,
        isAdmin: isLocalhost,
        clients: getClientsList()
    }));
    
    broadcastExcept(ws, {
        type: 'system',
        text: `${defaultName} joined. ${clients.size} online.`
    });
    
    broadcastToAll({ type: 'clientList', clients: getClientsList() });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const clientData = clients.get(ws);
            if (!clientData) return;
            
            msg.from = clientId;
            msg.fromName = clientData.displayName || clientData.name;
            msg.timestamp = Date.now();
            
            // Set username
            if (msg.type === 'setName') {
                if (msg.name && msg.name.trim().length > 0 && msg.name.trim().length <= 20) {
                    const oldName = clientData.displayName;
                    clientData.name = msg.name.trim();
                    clientData.displayName = msg.name.trim();
                    broadcastToAll({ type: 'system', text: `${oldName} is now known as ${clientData.displayName}.` });
                    ws.send(JSON.stringify({ type: 'nameUpdated', name: clientData.displayName, isAdmin: clientData.isAdmin }));
                    broadcastToAll({ type: 'clientList', clients: getClientsList() });
                }
                return;
            }
            
            // Check muted
            if (mutedClients.has(clientId) && (msg.type === 'msg' || msg.type === 'test')) {
                ws.send(JSON.stringify({ type: 'system', text: 'You are muted.' }));
                // Tell admin that muted person tried to talk
                broadcastToAll({ type: 'muted-notice', from: clientId, fromName: clientData.displayName, text: msg.text });
                return;
            }
            
            // ADMIN COMMANDS
            if (msg.type === 'admin-login') {
                if (msg.password === ADMIN_PASSWORD) {
                    ws.send(JSON.stringify({ type: 'admin-auth', success: true, clients: getClientsList(), log: messageLog.slice(-50), bannedIPs: Array.from(bannedIPs) }));
                } else {
                    ws.send(JSON.stringify({ type: 'admin-auth', success: false, text: 'Wrong password' }));
                }
                return;
            }
            
            if (msg.type === 'admin-kick' && msg.adminPassword === ADMIN_PASSWORD) { kickClient(msg.targetId); broadcastToAll({ type: 'system', text: `Client ${msg.targetId} was kicked.` }); return; }
            if (msg.type === 'admin-ban' && msg.adminPassword === ADMIN_PASSWORD) { banClient(msg.targetId); broadcastToAll({ type: 'system', text: `Client ${msg.targetId} was banned.` }); return; }
            
            if (msg.type === 'admin-mute' && msg.adminPassword === ADMIN_PASSWORD) {
                if (mutedClients.has(msg.targetId)) {
                    mutedClients.delete(msg.targetId);
                    sendToClient(msg.targetId, { type: 'system', text: 'You have been unmuted.' });
                } else {
                    mutedClients.add(msg.targetId);
                    sendToClient(msg.targetId, { type: 'system', text: 'You have been muted by admin.' });
                }
                broadcastToAll({ type: 'clientList', clients: getClientsList() });
                return;
            }
            
            if (msg.type === 'admin-broadcast' && msg.adminPassword === ADMIN_PASSWORD) { broadcastToAll({ type: 'system', text: `📢 ADMIN: ${msg.text}` }); return; }
            if (msg.type === 'admin-pm' && msg.adminPassword === ADMIN_PASSWORD) { sendToClient(msg.targetId, { type: 'pm', text: msg.text, from: 'ADMIN', fromName: '🛡️ ADMIN' }); ws.send(JSON.stringify({ type: 'pm-sent', text: msg.text, targetId: msg.targetId })); return; }
            if (msg.type === 'admin-unban' && msg.adminPassword === ADMIN_PASSWORD) { bannedIPs.delete(msg.ip); broadcastToAll({ type: 'system', text: `IP ${msg.ip} was unbanned.` }); return; }
            
            // Regular message — broadcast to everyone except sender
            clientData.messageCount++;
            messageLog.push({ from: clientId, fromName: clientData.displayName, type: msg.type, text: msg.text || '', time: new Date().toISOString() });
            if (messageLog.length > 200) messageLog.shift();
            
            console.log(`📨 ${clientData.displayName}: ${msg.text || msg.type}`);
            broadcastExcept(ws, msg);
            
        } catch (e) { console.log('Invalid message:', e.message); }
    });
    
    ws.on('close', () => {
        const clientData = clients.get(ws);
        const name = clientData?.displayName || 'Unknown';
        clients.delete(ws);
        mutedClients.delete(clientId);
        console.log(`👋 ${name} left. ${clients.size} online.`);
        broadcastToAll({ type: 'system', text: `${name} left. ${clients.size} online.` });
        broadcastToAll({ type: 'clientList', clients: getClientsList() });
    });
    
    ws.on('error', (err) => {
        console.log('WebSocket error:', err.message);
        clients.delete(ws);
        mutedClients.delete(clientId);
    });
});

server.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('  📻 MORSE CHAT SERVER v2');
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
    console.log('  Press Ctrl+C to stop');
    console.log('═══════════════════════════════════');
});