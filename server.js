require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const wav = require('node-wav');
const Meyda = require('meyda');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar multer para guardar archivos de audio
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './uploads/voice_samples';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Database connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        return;
    }
    console.log('Connected to MySQL database');
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Register endpoint
app.post('/api/register', upload.single('voiceFile'), (req, res) => {
    const { username, voicePassphrase } = req.body;
    const voiceFilePath = req.file ? req.file.path : null;
    
    if (!voiceFilePath) {
        return res.status(400).json({ error: 'No se proporcionó archivo de voz' });
    }
    
    const voiceData = {
        text: voicePassphrase,
        audioPath: voiceFilePath
    };
    
    const query = 'INSERT INTO users (username, voice_passphrase, voice_file_path) VALUES (?, ?, ?)';
    db.query(query, [username, JSON.stringify(voiceData), voiceFilePath], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                // Si hay error, eliminar el archivo subido
                if (voiceFilePath) {
                    fs.unlinkSync(voiceFilePath);
                }
                return res.status(400).json({ error: 'El usuario ya existe' });
            }
            console.error('Error registering user:', err);
            return res.status(500).json({ error: 'Error registering user' });
        }
        res.json({ message: 'User registered successfully' });
    });
});

// Login endpoint
app.post('/api/login', upload.single('voiceFile'), (req, res) => {
    const { username, voicePassphrase } = req.body;
    const voiceFilePath = req.file ? req.file.path : null;
    
    if (!voiceFilePath) {
        return res.status(400).json({ error: 'No se proporcionó archivo de voz' });
    }
    
    const query = 'SELECT * FROM users WHERE username = ?';
    db.query(query, [username], async (err, results) => {
        if (err) {
            // Limpiar archivo temporal
            if (voiceFilePath) {
                fs.unlinkSync(voiceFilePath);
            }
            console.error('Error during login:', err);
            return res.status(500).json({ error: 'Error during login' });
        }
        
        if (results.length === 0) {
            if (voiceFilePath) {
                fs.unlinkSync(voiceFilePath);
            }
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        const storedData = JSON.parse(results[0].voice_passphrase);
        
        try {
            // Verificar que la frase sea la misma
            if (storedData.text !== voicePassphrase) {
                if (voiceFilePath) {
                    fs.unlinkSync(voiceFilePath);
                }
                return res.status(401).json({ error: 'Frase de voz incorrecta' });
            }
            
            // Comparar las voces
            const similarity = await compareVoiceSamples(storedData.audioPath, voiceFilePath);
            
            // Limpiar archivo temporal de login
            fs.unlinkSync(voiceFilePath);
            
            // Umbral más estricto para la similitud (85%)
            if (similarity < 85) {
                return res.status(401).json({ 
                    error: 'La voz no coincide con el registro', 
                    similarity: similarity,
                    message: similarity < 60 ? 
                        'La voz es muy diferente a la registrada' :
                        'La voz es similar pero no lo suficiente para autenticar. Se requiere al menos 85% de similitud.'
                });
            }
            
            const token = jwt.sign({ userId: results[0].id }, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.json({ 
                token, 
                similarity,
                message: similarity >= 90 ? 
                    'Coincidencia excelente' : 
                    'Coincidencia aceptable'
            });
            
        } catch (error) {
            // Limpiar archivo temporal en caso de error
            if (voiceFilePath) {
                fs.unlinkSync(voiceFilePath);
            }
            console.error('Error processing voice data:', error);
            return res.status(500).json({ error: 'Error processing voice data' });
        }
    });
});

// Función para extraer características MFCC del audio
function extractMFCC(audioBuffer, sampleRate) {
    // Configurar Meyda con parámetros más precisos
    Meyda.bufferSize = 1024;
    const windowSize = 2048;
    const hopSize = 512;
    
    // Convertir a mono si es necesario
    let audioData = audioBuffer;
    if (Array.isArray(audioBuffer)) {
        audioData = audioBuffer[0];
    }
    
    const numFrames = Math.floor((audioData.length - windowSize) / hopSize) + 1;
    let features = [];
    
    for (let i = 0; i < numFrames; i++) {
        const startIndex = i * hopSize;
        const frame = audioData.slice(startIndex, startIndex + windowSize);
        
        // Extraer múltiples características para cada frame
        const frameFeatures = Meyda.extract([
            'mfcc',           // Coeficientes MFCC
            'rms',            // Energía RMS
            'spectralCentroid', // Centro de masa espectral
            'spectralRolloff',  // Frecuencia de corte espectral
            'spectralFlatness', // Planitud espectral
            'zcr'             // Tasa de cruces por cero
        ], frame, sampleRate);
        
        features.push(frameFeatures);
    }
    
    return features;
}

// Función para calcular la similitud entre dos conjuntos de características
function calculateFeatureSimilarity(featuresA, featuresB) {
    const weights = {
        mfcc: 0.5,           // Mayor peso para MFCC ya que es muy importante para identificación de voz
        rms: 0.1,            // Peso moderado para energía
        spectralCentroid: 0.1, // Peso moderado para características espectrales
        spectralRolloff: 0.1,
        spectralFlatness: 0.1,
        zcr: 0.1             // Peso moderado para cruces por cero
    };

    let totalSimilarity = 0;
    let frameCount = 0;
    const minFrames = Math.min(featuresA.length, featuresB.length);
    
    for (let i = 0; i < minFrames; i++) {
        let frameSimilarity = 0;
        
        // Comparar MFCC (usando similitud coseno)
        const mfccSimilarity = cosineSimilarity(featuresA[i].mfcc, featuresB[i].mfcc);
        frameSimilarity += mfccSimilarity * weights.mfcc;
        
        // Comparar RMS (usando diferencia normalizada)
        const rmsDiff = Math.abs(featuresA[i].rms - featuresB[i].rms) / Math.max(featuresA[i].rms, featuresB[i].rms);
        frameSimilarity += (1 - rmsDiff) * weights.rms;
        
        // Comparar características espectrales
        const centroidDiff = Math.abs(featuresA[i].spectralCentroid - featuresB[i].spectralCentroid) / 
                           Math.max(featuresA[i].spectralCentroid, featuresB[i].spectralCentroid);
        frameSimilarity += (1 - centroidDiff) * weights.spectralCentroid;
        
        const rolloffDiff = Math.abs(featuresA[i].spectralRolloff - featuresB[i].spectralRolloff) / 
                          Math.max(featuresA[i].spectralRolloff, featuresB[i].spectralRolloff);
        frameSimilarity += (1 - rolloffDiff) * weights.spectralRolloff;
        
        const flatnessDiff = Math.abs(featuresA[i].spectralFlatness - featuresB[i].spectralFlatness) / 
                           Math.max(featuresA[i].spectralFlatness, featuresB[i].spectralFlatness);
        frameSimilarity += (1 - flatnessDiff) * weights.spectralFlatness;
        
        // Comparar ZCR
        const zcrDiff = Math.abs(featuresA[i].zcr - featuresB[i].zcr) / Math.max(featuresA[i].zcr, featuresB[i].zcr);
        frameSimilarity += (1 - zcrDiff) * weights.zcr;
        
        totalSimilarity += frameSimilarity;
        frameCount++;
    }
    
    // Calcular similitud promedio y normalizar a porcentaje
    const averageSimilarity = (totalSimilarity / frameCount) * 100;
    
    // Aplicar una función sigmoide para hacer la comparación más estricta
    const adjustedSimilarity = 100 / (1 + Math.exp(-0.1 * (averageSimilarity - 75)));
    
    return Math.max(0, Math.min(100, adjustedSimilarity));
}

// Función para calcular la similitud coseno entre dos vectores
function cosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
    const normA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
    const normB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
    return dotProduct / (normA * normB);
}

// Función para comparar muestras de voz
async function compareVoiceSamples(storedPath, newPath) {
    try {
        // Leer los archivos de audio
        const storedBuffer = fs.readFileSync(storedPath);
        const newBuffer = fs.readFileSync(newPath);
        
        // Decodificar los archivos WAV
        const storedAudio = wav.decode(storedBuffer);
        const newAudio = wav.decode(newBuffer);
        
        // Verificar que las duraciones sean similares (dentro de un margen del 20%)
        const durationDiff = Math.abs(storedAudio.length - newAudio.length) / Math.max(storedAudio.length, newAudio.length);
        if (durationDiff > 0.2) {
            console.log('Duración de audio muy diferente:', durationDiff);
            return 30; // Penalizar diferencias grandes en duración
        }
        
        // Extraer características
        const storedFeatures = extractMFCC(storedAudio.channelData[0], storedAudio.sampleRate);
        const newFeatures = extractMFCC(newAudio.channelData[0], newAudio.sampleRate);
        
        // Calcular similitud
        const similarity = calculateFeatureSimilarity(storedFeatures, newFeatures);
        
        // Aplicar umbral más estricto
        if (similarity < 75) {
            console.log('Similitud por debajo del umbral:', similarity);
            return similarity * 0.8; // Penalizar aún más las similitudes bajas
        }
        
        return similarity;
        
    } catch (error) {
        console.error('Error comparing voice samples:', error);
        return 0;
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 