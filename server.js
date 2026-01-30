
// ... (mismas constantes e imports anteriores)

// Nuevo Esquema de Producto con Galería
const ProductoSchema = new mongoose.Schema({
    nombre: String,
    categoria: String,
    precioBase: Number,
    imagenes: [String], // Array de hasta 3 URLs de ImgBB
    stock: { type: Boolean, default: true }
});
const Producto = mongoose.model('Producto', ProductoSchema);

// ... (rutas de consulta GET /api/productos se mantienen igual)

// MODIFICACIÓN: Envío a Telegram mejorado
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    const { catalogPath, clientName, joyaNombre } = req.body;
    const clientId = Date.now();
    res.json({ success: true, clientId });

    try {
        await Venta.create({ cliente: clientName, joya: joyaNombre });

        // Creamos un Media Group (Álbum) para Telegram
        // Imagen 1: El cliente | Imagen 2: La joya de catálogo
        const mediaGroup = [
            {
                type: 'photo',
                media: 'attach://userPhoto',
                caption: `👤 **PEDIDO LUXURY**\nCliente: ${clientName}\n💍 Joya: ${joyaNombre}\n🆔 ID: ${clientId}`
            },
            {
                type: 'photo',
                media: 'attach://catalogPhoto'
            }
        ];

        const formData = new FormData();
        formData.append('chat_id', CHAT_ID);
        formData.append('media', JSON.stringify(mediaGroup));
        formData.append('userPhoto', fs.createReadStream(req.file.path));
        
        // Descargamos la imagen del catálogo para reenviarla
        const responseImg = await axios.get(catalogPath, { responseType: 'arraybuffer' });
        formData.append('catalogPhoto', Buffer.from(responseImg.data), { filename: 'joya.jpg' });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`, formData, {
            headers: formData.getHeaders()
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (error) {
        console.error("Error envío agrupado:", error.message);
    }
});
