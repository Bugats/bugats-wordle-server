import express from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const app = express();
const PORT = process.env.PORT || 10080;
const JWT_SECRET = 'Bugats_Vards';  // Maini šo uz savu noslēpumu!

app.use(express.json());
app.use(express.static('public'));

const usersFilePath = 'users.json';

// Palīdzīgā funkcija lasīšanai un rakstīšanai uz 'users.json'
const getUsers = () => {
  const usersData = fs.readFileSync(usersFilePath, 'utf-8');
  return JSON.parse(usersData);
};

const saveUsers = (users) => {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf-8');
};

// Sign-up: Lietotāja reģistrēšana
app.post('/signup', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const users = getUsers();
  const userExists = users.find(user => user.username === username);

  if (userExists) {
    return res.status(400).json({ message: 'Username already exists' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = { username, password: hashedPassword };
  users.push(newUser);

  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
  res.status(201).json({ token });
});

// Sign-in: Lietotāja pierakstīšanās
app.post('/signin', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const users = getUsers();
  const user = users.find(user => user.username === username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
  res.status(200).json({ token });
});

// Middleware, kas pārbauda JWT tokenu
const authenticateJWT = (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];

  if (!token) {
    return res.status(403).json({ message: 'Access denied, no token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Piemērs, kā aizsargāt maršrutu, lai tikai autorizēti lietotāji piekļūtu
app.get('/game', authenticateJWT, (req, res) => {
  res.json({ message: 'Welcome to the game!', username: req.user.username });
});

// Ieslēdz serveri
app.listen(PORT, () => {
  console.log(`Serveris darbojas uz portu ${PORT}`);
});
