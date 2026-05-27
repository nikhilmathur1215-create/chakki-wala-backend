require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.SUPABASE_URL,
    ssl: false
});

async function testConnection() {
    try {
        const result = await pool.query('SELECT NOW() as current_time');
        console.log('✅ Database connected successfully!');
        console.log('📅 Database time:', result.rows[0].current_time);
        process.exit(0);
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        console.log('\n🔧 Troubleshooting:');
        console.log('1. Check your password in .env file');
        console.log('2. Make sure Supabase project is active');
        console.log('3. Check if URL has correct format');
        process.exit(1);
    }
}

testConnection();
