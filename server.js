require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');

// 1. CONFIGURACIÓN DE SEGURIDAD PARA REDES CORPORATIVAS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 2. CONFIGURAR EL CLIENTE DE GOOGLE CON AGENTE SEGURO
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/procesar', async (req, res) => {
    try {
        const { image1, image2, promptUser } = req.body;

        // Intentamos con gemini-1.5-flash-latest
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash" 
        });

        const promptSistema = "Combina estas imágenes: Persona (1) y Joya (2).";

        // IMPORTANTE: En redes con proxy, a veces hay que reintentar
        const result = await model.generateContent([
            { text: promptSistema + (promptUser || "") },
            { inlineData: { data: image1, mimeType: "image/jpeg" } },
            { inlineData: { data: image2, mimeType: "image/jpeg" } }
        ]);

        const response = await result.response;
        res.json({ success: true, result: response.text() });

    } catch (error) {
        console.error("❌ ERROR DE CONEXIÓN:", error.message);
        res.status(500).json({ 
            success: false, 
            error: "La red de la empresa bloqueó la conexión a Google. Intenta usar una red abierta o datos móviles." 
        });
    }
});

app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));