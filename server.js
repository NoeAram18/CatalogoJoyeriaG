const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// 1. Configuración de Conexión a Aiven PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Obligatorio para Aiven
  }
});

// Probar conexión y CREAR LA TABLA AUTOMÁTICAMENTE
pool.connect((err) => {
  if (err) {
    console.error('Error conectando a Aiven PostgreSQL:', err.stack);
  } else {
    console.log('Gedalia ERP Online - ¡Conectado a Aiven con éxito! 💎');
    
    // TRUCO: El servidor crea la tabla de joyería si no existe
    const crearTablaSQL = `
      CREATE TABLE IF NOT EXISTS productos (
          id SERIAL PRIMARY KEY,
          codigo VARCHAR(50) UNIQUE NOT NULL,
          nombre VARCHAR(100) NOT NULL,
          precio NUMERIC(10, 2) NOT NULL,
          stock INT NOT NULL
      );
    `;
    
    pool.query(crearTablaSQL, (errQuery, resQuery) => {
      if (errQuery) {
        console.error('Error creando la tabla en Aiven:', errQuery.stack);
      } else {
        console.log('Tabla "productos" verificada y lista para las 800 piezas. 🛠️');
      }
    });
  }
});

// 2. Rutas para mostrar tus páginas HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 3. API RETAIL: Obtener los productos para el catálogo
app.get('/api/productos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el inventario de joyería' });
  }
});

// 4. API ERP: Agregar una nueva joya de plata
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

// Encender el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Gedalia ERP corriendo en el puerto ${PORT}`);
});
