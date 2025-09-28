const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Get all drinks
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM drinks ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load drinks' });
  }
});

// Add a drink
router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query('INSERT INTO drinks(name) VALUES($1) RETURNING *', [name.trim()]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(400).json({ error: 'Drink already exists' });
    }
    res.status(500).json({ error: 'Failed to add drink' });
  }
});

// Remove a drink
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM drinks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete drink' });
  }
});

module.exports = router;
