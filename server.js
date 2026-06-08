require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize PostgreSQL Connection Pool
// This looks for a DATABASE_URL variable in your .env file
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required by many managed database providers (like Supabase/Neon/Render)
    }
});

// Initialize Database Table
async function initDB() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS registrations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            checked_in BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            checkin_time TIMESTAMP,
            checkin_count INTEGER DEFAULT 0,
            override_count INTEGER DEFAULT 0
        );
    `;
    try {
        await pool.query(createTableQuery);
        // Migrations to support override counters
        await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS checkin_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS override_count INTEGER DEFAULT 0`);
        console.log('Connected to central PostgreSQL database and verified table with migrations.');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}
initDB();

// --- VALIDATION HELPERS ---
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateRegistration(name, email) {
    if (!name || typeof name !== 'string') return 'Name is required';
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
        return 'Name must be between 2 and 100 characters';
    }
    if (!email || typeof email !== 'string') return 'Email is required';
    const trimmedEmail = email.trim().toLowerCase();
    if (trimmedEmail.length > 100) {
        return 'Email must be under 100 characters';
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
        return 'Please provide a valid email address';
    }
    return null;
}

function validateUUID(id) {
    return id && typeof id === 'string' && UUID_V4_REGEX.test(id);
}

// --- API ENDPOINTS ---

// 1. Register a user
app.post('/api/register', async (req, res) => {
    let { name, email } = req.body;
    
    // Clean and validate
    const validationError = validateRegistration(name, email);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const registrationId = uuidv4();

    try {
        await pool.query(
            `INSERT INTO registrations (id, name, email) VALUES ($1, $2, $3)`,
            [registrationId, cleanName, cleanEmail]
        );
        res.status(201).json({ success: true, registrationId });
    } catch (err) {
        console.error('Registration Database Error:', err);
        // Handle unique constraint if email is unique or other errors
        res.status(500).json({ error: 'Failed to complete registration due to database error' });
    }
});

// 2. Verify registration (Optional pre-check)
app.get('/api/verify/:id', async (req, res) => {
    const { id } = req.params;

    if (!validateUUID(id)) {
        return res.status(400).json({ error: 'Invalid registration ID format' });
    }

    try {
        const result = await pool.query(`SELECT * FROM registrations WHERE id = $1`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Registration not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Verification Database Error:', err);
        res.status(500).json({ error: 'Database error occurred during verification' });
    }
});

// 3. Process Check-in
app.post('/api/checkin/:id', async (req, res) => {
    const { id } = req.params;
    const { override } = req.body;

    if (!validateUUID(id)) {
        return res.status(400).json({ error: 'Invalid registration ID format' });
    }

    try {
        // First, check the current status
        const result = await pool.query(`SELECT * FROM registrations WHERE id = $1`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Registration not found' });
        }

        const user = result.rows[0];

        // Check if already checked in, and override is not requested
        if (user.checked_in && !override) {
            return res.status(409).json({ 
                error: 'Already checked in', 
                user: user.name,
                email: user.email,
                time: user.checkin_time,
                checkin_count: user.checkin_count || 1
            });
        }

        if (override) {
            // Mark as duplicate check-in (override)
            await pool.query(
                `UPDATE registrations 
                 SET checked_in = TRUE, 
                     checkin_time = CURRENT_TIMESTAMP, 
                     checkin_count = COALESCE(checkin_count, 0) + 1, 
                     override_count = COALESCE(override_count, 0) + 1 
                 WHERE id = $1`,
                [id]
            );
            res.json({ 
                success: true, 
                message: 'Check-in overridden!', 
                user: user.name, 
                email: user.email, 
                override: true 
            });
        } else {
            // First time check-in
            await pool.query(
                `UPDATE registrations 
                 SET checked_in = TRUE, 
                     checkin_time = CURRENT_TIMESTAMP, 
                     checkin_count = 1 
                 WHERE id = $1`,
                [id]
            );
            res.json({ 
                success: true, 
                message: 'Registration confirmed!', 
                user: user.name, 
                email: user.email, 
                override: false 
            });
        }
    } catch (err) {
        console.error('Check-in Database Error:', err);
        res.status(500).json({ error: 'Error updating check-in status on database' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));