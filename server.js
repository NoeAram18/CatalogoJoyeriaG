
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// Permitir que el servidor entienda datos JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir automáticamente archivos estáticos (HTML, CSS, JS si los tienes en la raíz)
app.use(express.static(path.join(__dirname)));

// 1. Configuración de Conexión a Aiven PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // ¡OBLIGATORIO! Aiven exige SSL seguro para conectar desde Render
  }
});

// Probar conexión en los logs de Render
pool.connect((err) => {
  if (err) {
    console.error('Error conectando a Aiven PostgreSQL:', err.stack);
  } else {
    console.log('Gedalia ERP Online - ¡Conectado a Aiven con éxito! 💎');
  }
});

// 2. Rutas para mostrar tus páginas HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 3. API RETAIL: Obtener las 800 piezas de joyería para el catálogo
app.get('/api/productos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
    res.json(result.rows); // PostgreSQL devuelve las filas en .rows
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el inventario de joyería' });
  }
});

// 4. API ERP: Agregar una nueva joya de plata desde el panel admin
app.post('/api/productos', async (req, res) => {
  const { codigo, nombre, precio, stock } = req.body;
  try {
    const query = 'INSERT INTO productos (codigo, nombre, precio, stock) VALUES ($1, $2, $3, $4) RETURNING *';
    const values = [codigo, nombre, precio, stock];
    const result = await pool.query(query, values);
    res.status(201).json({ mensaje: 'Joya guardada con éxito', producto: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la pieza en la base de datos' });
  }
});

// Encender el servidor en Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Gedalia ERP corriendo en el puerto ${PORT}`);
});
