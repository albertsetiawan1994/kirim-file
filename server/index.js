const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mdns = require('multicast-dns')();
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());

// Health Check for Render/Auto-resume
app.get('/health', (req, res) => res.status(200).send('OK'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow all origins for signaling server (safe as it only relays signals)
      callback(null, true);
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'] // Prefer websocket
});

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const PORT = process.env.PORT || 3001;
const IP = getLocalIP();

// mDNS discovery for local networks
mdns.on('query', (query) => {
  if (query.questions.some(q => q.name === 'kirim-file.local')) {
    mdns.respond({
      answers: [{
        name: 'kirim-file.local',
        type: 'A',
        ttl: 300,
        data: IP
      }, {
        name: 'kirim-file.local',
        type: 'TXT',
        data: `port=${PORT}`
      }]
    });
  }
});

// Signaling Server State
const users = new Map();

function broadcastUsersList() {
  const usersArray = Array.from(users.values());
  
  // Deduplicate by name: keep only the latest connection for each device name
  const uniqueUsersMap = new Map();
  usersArray.forEach(user => {
    const existing = uniqueUsersMap.get(user.name);
    if (!existing || user.joinedAt > existing.joinedAt) {
      uniqueUsersMap.set(user.name, user);
    }
  });
  const deduplicatedUsers = Array.from(uniqueUsersMap.values());
  
  // Send personalized list to each socket
  io.sockets.sockets.forEach((socket) => {
    const currentUser = users.get(socket.id);
    if (!currentUser) return;

    const personalizedList = deduplicatedUsers.map(user => {
      // Helper to normalize IP (remove ipv6 prefix)
      const normalizeIP = (ip) => {
        if (!ip || typeof ip !== 'string') return '';
        if (ip.startsWith('::ffff:')) return ip.substring(7);
        if (ip === '::1') return '127.0.0.1';
        return ip;
      };

      const userIP = normalizeIP(user.ip);
      const currentIP = normalizeIP(currentUser.ip);
      
      // Local if:
      // 1. Same IP (Public Gateway)
      // 2. Both are localhost (for local development)
      // 3. One is localhost and other matches server IP (rare but possible)
      const isLocal = userIP && currentIP && 
                     (userIP === currentIP || (userIP === '127.0.0.1' && currentIP === '127.0.0.1')) && 
                     user.id !== currentUser.id;
      
      return {
        id: user.id,
        name: user.name,
        deviceType: user.deviceType,
        browser: user.browser,
        joinedAt: user.joinedAt,
        isLocal: !!isLocal
      };
    });

    socket.emit('users-list', personalizedList);
  });
}

io.on('connection', (socket) => {
  // Get client's public IP address (handling proxies like Render/Cloudflare)
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const clientIp = forwarded ? forwarded.split(',')[0] : socket.handshake.address;

  socket.on('join', (userData) => {
    // Explicitly prioritize gatewayIP from client, fallback to detected clientIp
    const user = { 
      ...userData, 
      id: socket.id, 
      joinedAt: Date.now(),
      ip: userData.gatewayIP || clientIp
    };
    
    // If name exists, we could update the existing entry but socket.id is our primary key
    // broadcastUsersList already handles deduplication by name for the UI
    users.set(socket.id, user);
    
    broadcastUsersList();
  });

  socket.on('signal', ({ to, from, signal, pin }) => {
    // console.log(`[Signal] ${from} -> ${to}, type: ${signal?.type || 'unknown'}`);
    const recipient = users.get(to);
    if (recipient) {
      io.to(to).emit('signal', { from, signal, pin });
      // console.log(`[Signal] Delivered to ${recipient.name}`);
    } else {
      // console.warn(`[Signal] Recipient ${to} not found online`);
      // Notify sender that recipient is offline
      io.to(from).emit('signal-error', { code: 'RECIPIENT_OFFLINE' });
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      broadcastUsersList();
      // console.log(`❌ User disconnected: ${user.name}`);
    }
  });

  // Heartbeat to keep connection alive on some platforms
  socket.on('ping', () => socket.emit('pong'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 Kirim File Backend Active
  --------------------------
  Port      : ${PORT}
  Local IP  : ${IP}
  URL       : http://${IP}:${PORT}
  mDNS      : kirim-file.local
  --------------------------
  `);
});
