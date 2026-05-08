const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mdns = require('multicast-dns')();
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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

// mDNS discovery
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

// Socket.IO Signaling
const users = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (userData) => {
    users[socket.id] = { ...userData, id: socket.id };
    io.emit('users-list', Object.values(users));
  });

  socket.on('signal', ({ to, from, signal }) => {
    io.to(to).emit('signal', { from, signal });
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('users-list', Object.values(users));
    console.log('User disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://${IP}:${PORT}`);
  console.log(`mDNS service broadcasted as kirim-file.local`);
});
