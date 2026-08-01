const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./config/database');

process.env.TZ = 'Europe/Berlin';
db.query("SET timezone = 'Europe/Berlin';").catch(() => {});

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const { verifyToken, requireAdmin } = require('./middleware/auth');

// Routen importieren
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const projectRoutes = require('./routes/projectRoutes');
const customerRoutes = require('./routes/customerRoutes');
const timetrackingRoutes = require('./routes/timetrackingRoutes');
const vacationRoutes = require('./routes/vacationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const articleRoutes = require('./routes/articleRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const tickerRoutes = require('./routes/tickerRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes'); // NEU: Dashboard-Route importieren

// Öffentliche Auth-Routen
app.use('/', authRoutes);

// Alle folgenden Routen schützen
app.use(verifyToken);

// Dashboard als Startseite nach Login einbinden
app.use('/', dashboardRoutes); // NEU: Übernimmt die Route '/'

app.use('/documents', documentRoutes);
app.use('/projects', projectRoutes);
app.use('/customers', customerRoutes);
app.use('/timetracking', timetrackingRoutes);
app.use('/vacations', vacationRoutes);
app.use('/admin', requireAdmin, adminRoutes);
app.use('/articles', articleRoutes);
app.use('/calendar', calendarRoutes);
app.use('/ticker', tickerRoutes);

app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
