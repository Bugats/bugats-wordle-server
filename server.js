// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 10080;

// Statiskie faili (front-end) tiks servēti no šīs mapes
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Vārdu Zona serveris darbojas!');
});

// Socket.IO savienojuma izveide
io.on('connection', (socket) => {
  console.log('New player connected');
  
  socket.on('disconnect', () => {
    console.log('Player disconnected');
  });
  
  // Pievieno citas spēles loģikas un notikumus šeit
});

server.listen(PORT, () => {
  console.log(`Serveris darbojas uz portu ${PORT}`);
});
