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

io.on('connection', (socket) => {
  console.log('⚡ Client connected:', socket.id);

  // Get client's IP address
  const clientIp = socket.handshake.address;
  const isLocalClient = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.includes('192.168.') || clientIp.includes('10.');

  socket.on('join', (userData) => {
    const user = { 
      ...userData, 
      id: socket.id, 
      joinedAt: Date.now(),
      ip: clientIp,
      isLocal: isLocalClient
    };
    users.set(socket.id, user);
    
    // Broadcast updated users list to ALL connected clients
    io.emit('users-list', Array.from(users.values()));
    console.log(`👤 User joined/updated: ${user.name} (${user.deviceType})`);
  });

  socket.on('signal', ({ to, from, signal, pin }) => {
    // Optional: Filter by PIN if provided
    const recipient = users.get(to);
    if (recipient) {
      io.to(to).emit('signal', { from, signal, pin });
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('users-list', Array.from(users.values()));
      console.log(`❌ User disconnected: ${user.name}`);
    }
  });

  // Heartbeat to keep connection alive on some platforms
  socket.on('ping', () => socket.emit('pong'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 KirimFile Backend Active
  --------------------------
  Port      : ${PORT}
  Local IP  : ${IP}
  URL       : http://${IP}:${PORT}
  mDNS      : kirim-file.local
  --------------------------
  `);
});
