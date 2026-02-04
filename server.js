
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

mongoose.connect(process.env.MONGO_URI);

const Producto = mongoose.model('Producto', new mongoose.Schema({
    nombre: String,
    categoria: String,
    precioBase: Number,
    imagenes: [String],
    vistas: { type: Number, default: 0 },
    interacciones: { type: Number, default: 0 },
    stock: { type: Boolean, default: true },
    descuento: { type: Number, default: 0 },
    envioGratis: { type: Boolean, default: false }
}, { timestamps: true }));

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
const upload = multer({ dest: 'uploads/' });

// ENDPOINTS PÚBLICOS
app.get('/api/productos', async (req, res) => {
    res.json(await Producto.find({ stock: true }).sort({ _id: -1 }));
});

app.post('/api/productos/view/:id', async (req, res) => {
    await Producto.findByIdAndUpdate(req.params.id, { $inc: { vistas: 1 } });
    res.sendStatus(200);
});

app.post('/api/productos/interact/:id', async (req, res) => {
    await Producto.findByIdAndUpdate(req.params.id, { $inc: { interacciones: 1 } });
    res.sendStatus(200);
});

// ENDPOINTS ADMIN
app.get('/api/admin/productos-todos', async (req, res) => {
    res.json(await Producto.find().sort({ vistas: -1 }));
});

app.post('/api/admin/upload-image', upload.single('image'), async (req, res) => {
    try {
        const form = new FormData();
        form.append('image', fs.createReadStream(req.file.path));
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.json({ url: response.data.data.url });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send("Error en carga");
    }
});

app.post('/api/admin/productos-bulk', async (req, res) => {
    try {
        const result = await Producto.insertMany(req.body);
        res.json({ success: true, count: result.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/productos', async (req, res) => {
    res.json(await Producto.create(req.body));
});

app.patch('/api/admin/productos/:id', async (req, res) => {
    res.json(await Producto.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete('/api/admin/productos/:id', async (req, res) => {
    await Producto.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => console.log("Gedalia ERP Online"));
