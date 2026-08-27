const express = require('express');
const router  = express.Router();
const { dbQuery } = require('../utils/db');
const { ensureChatTable } = require('../utils/chatSocket');

// ==========================================
// TEAM-CHAT
// ==========================================
router.get('/', async (req, res) => {
  try {
    await ensureChatTable();
    const result = await dbQuery(
      `SELECT chat_messages.id, chat_messages.channel, chat_messages.user_id,
              chat_messages.message, chat_messages.created_at, users.username
       FROM chat_messages
       JOIN users ON users.id = chat_messages.user_id
       WHERE chat_messages.channel = 'team'
       ORDER BY chat_messages.id DESC
       LIMIT 50`
    );
    const messages = (result.rows || []).reverse();
    res.render('chat', {
      channel: 'team',
      channelTitle: 'Team-Chat',
      backLink: '/',
      messages,
      currentUser: req.user
    });
  } catch (err) {
    console.error('Fehler beim Laden des Team-Chats:', err.message);
    res.status(500).send('Fehler beim Laden des Chats: ' + err.message);
  }
});

module.exports = router;
