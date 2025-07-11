// Inicialización del reconocimiento de voz
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();
recognition.lang = 'es-ES';
recognition.continuous = false;
recognition.interimResults = false;

// Variables globales
let isRecording = false;
let currentVoicePhrase = '';
let currentForm = 'login';
let audioContext = null;
let mediaRecorder = null;
let audioChunks = [];
let voiceFeatures = null;
let audioBlob = null;

// Elementos DOM
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const welcomeScreen = document.getElementById('welcomeScreen');
const showRegisterLink = document.getElementById('showRegister');
const showLoginLink = document.getElementById('showLogin');
const startLoginVoice = document.getElementById('startLoginVoice');
const startRegisterVoice = document.getElementById('startRegisterVoice');
const loginVoiceStatus = document.getElementById('loginVoiceStatus');
const registerVoiceStatus = document.getElementById('registerVoiceStatus');
const loginButton = document.getElementById('loginButton');
const registerButton = document.getElementById('registerButton');
const logoutButton = document.getElementById('logoutButton');

// Funciones de navegación
showRegisterLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchForm('register');
});

showLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchForm('login');
});

function switchForm(form) {
    currentForm = form;
    loginForm.classList.remove('active');
    registerForm.classList.remove('active');
    welcomeScreen.classList.remove('active');
    
    if (form === 'login' || form === 'register') {
        clearAuthData();
    }
    
    if (form === 'login') {
        loginForm.classList.add('active');
    } else if (form === 'register') {
        registerForm.classList.add('active');
    } else if (form === 'welcome') {
        welcomeScreen.classList.add('active');
    }
}

// Función para convertir audio a WAV
async function convertToWav(audioBlob) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Crear buffer WAV
    const numberOfChannels = 1; // Mono
    const length = audioBuffer.length;
    const sampleRate = 16000;
    const wavBuffer = audioContext.createBuffer(numberOfChannels, length, sampleRate);
    
    // Copiar datos de audio
    const channelData = audioBuffer.getChannelData(0);
    wavBuffer.copyToChannel(channelData, 0);
    
    // Convertir a WAV
    const wavBlob = await audioBufferToWav(wavBuffer);
    return new Blob([wavBlob], { type: 'audio/wav' });
}

// Función para convertir AudioBuffer a WAV
function audioBufferToWav(buffer) {
    const numberOfChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numberOfChannels * 2;
    const arrayBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(arrayBuffer);
    
    // Escribir cabecera WAV
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * 2, true);
    view.setUint16(32, numberOfChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, length, true);
    
    // Escribir datos de audio
    const channelData = buffer.getChannelData(0);
    let offset = 44;
    for (let i = 0; i < channelData.length; i++) {
        const sample = Math.max(-1, Math.min(1, channelData[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
    }
    
    return arrayBuffer;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Función para extraer características de la voz
async function extractVoiceFeatures(audioBuffer) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    
    analyser.getFloatFrequencyData(dataArray);
    
    // Extraer características básicas de la voz
    const features = {
        frequency: Array.from(dataArray),
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate
    };
    
    return features;
}

// Función para comparar voces
async function compareVoices() {
    try {
        const storedVoice = JSON.parse(currentVoicePhrase).features;
        const currentVoice = voiceFeatures;
        
        // Calcular similitud usando correlación de frecuencias
        let similarity = 0;
        const minLength = Math.min(storedVoice.frequency.length, currentVoice.frequency.length);
        
        for (let i = 0; i < minLength; i++) {
            const diff = Math.abs(storedVoice.frequency[i] - currentVoice.frequency[i]);
            similarity += 1 - (diff / 100);
        }
        
        similarity = (similarity / minLength) * 100;
        return Math.max(0, Math.min(100, similarity));
    } catch (error) {
        console.error('Error comparing voices:', error);
        return 0;
    }
}

function updateSimilarityBar(similarity) {
    const progressBar = document.getElementById('similarityProgress');
    const container = document.querySelector('.similarity-container');
    container.style.display = 'block';
    progressBar.style.width = `${similarity}%`;
    progressBar.textContent = `${Math.round(similarity)}%`;
    progressBar.setAttribute('aria-valuenow', similarity);
    
    // Actualizar color basado en el porcentaje
    if (similarity >= 75) {
        progressBar.classList.remove('bg-danger', 'bg-warning');
        progressBar.classList.add('bg-success');
    } else if (similarity >= 70) {
        progressBar.classList.remove('bg-danger', 'bg-success');
        progressBar.classList.add('bg-warning');
    } else {
        progressBar.classList.remove('bg-success', 'bg-warning');
        progressBar.classList.add('bg-danger');
    }
}

// Modificar la configuración del reconocimiento de voz
recognition.onstart = () => {
    isRecording = true;
    audioChunks = [];
    if (mediaRecorder) {
        mediaRecorder.start();
    }
    const status = currentForm === 'login' ? loginVoiceStatus : registerVoiceStatus;
    status.textContent = 'Escuchando... Habla ahora';
    status.parentElement.classList.add('recording');
};

recognition.onend = () => {
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    const status = currentForm === 'login' ? loginVoiceStatus : registerVoiceStatus;
    status.textContent = 'Grabación finalizada';
    status.parentElement.classList.remove('recording');
};

recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    currentVoicePhrase = transcript;
    
    const status = currentForm === 'login' ? loginVoiceStatus : registerVoiceStatus;
    status.textContent = `Frase capturada: "${transcript}"`;
};

recognition.onerror = (event) => {
    const status = currentForm === 'login' ? loginVoiceStatus : registerVoiceStatus;
    status.textContent = `Error: ${event.error}`;
    status.parentElement.classList.remove('recording');
};

// Función para inicializar AudioContext
function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
        });
    }
    return audioContext;
}

// Función para inicializar el sistema de audio
async function initAudioSystem() {
    try {
        // Inicializar AudioContext
        audioContext = initAudioContext();
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                sampleSize: 16,
                echoCancellation: true,
                noiseSuppression: true
            } 
        });
        
        mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm'
        });
        
        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };
        
        mediaRecorder.onstop = async () => {
            try {
                const rawBlob = new Blob(audioChunks, { type: 'audio/webm' });
                audioBlob = await convertToWav(rawBlob);
                audioChunks = [];
                
                if (currentForm === 'login') {
                    const container = document.querySelector('.similarity-container');
                    if (container) {
                        container.style.display = 'block';
                        updateSimilarityBar(0); // Resetear barra mientras se procesa
                    }
                }
            } catch (error) {
                console.error('Error processing audio:', error);
                alert('Error al procesar el audio. Por favor, intenta de nuevo.');
            }
        };
        
        // Verificar que todo se inicializó correctamente
        if (!mediaRecorder || !audioContext) {
            throw new Error('Error initializing audio system components');
        }
        
        console.log('Audio system initialized successfully');
        
    } catch (err) {
        console.error('Error accessing microphone:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            alert('Por favor, permite el acceso al micrófono para usar esta función.');
        } else {
            alert('Error al acceder al micrófono. Asegúrate de que tienes un micrófono conectado y los permisos necesarios.');
        }
        throw err;
    }
}

// Manejadores de eventos para botones de voz
startLoginVoice.addEventListener('click', async () => {
    if (!isRecording) {
        try {
            if (!audioContext || !mediaRecorder) {
                await initAudioSystem();
            }
            recognition.start();
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Error al iniciar la grabación. Por favor, recarga la página e intenta de nuevo.');
        }
    }
});

startRegisterVoice.addEventListener('click', async () => {
    if (!isRecording) {
        try {
            if (!audioContext || !mediaRecorder) {
                await initAudioSystem();
            }
            recognition.start();
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Error al iniciar la grabación. Por favor, recarga la página e intenta de nuevo.');
        }
    }
});

// Funciones de autenticación
async function register() {
    const username = document.getElementById('registerUsername').value;
    
    if (!username || !currentVoicePhrase || !audioBlob) {
        alert('Por favor, ingresa un usuario y graba tu frase de voz');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('username', username);
        formData.append('voicePassphrase', currentVoicePhrase);
        formData.append('voiceFile', audioBlob, 'voice.webm');

        const response = await fetch('/api/register', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        
        if (response.ok) {
            alert('Registro exitoso');
            switchForm('login');
        } else {
            alert(data.error || 'Error en el registro');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error en el registro');
    }
}

async function login() {
    const username = document.getElementById('loginUsername').value;
    
    if (!username || !currentVoicePhrase || !audioBlob) {
        alert('Por favor, ingresa tu usuario y di tu frase de voz');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('username', username);
        formData.append('voicePassphrase', currentVoicePhrase);
        formData.append('voiceFile', audioBlob, 'voice.webm');

        const response = await fetch('/api/login', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        
        if (response.ok && data.similarity >= 75) {
            localStorage.setItem('token', data.token);
            updateSimilarityBar(data.similarity);
            setTimeout(() => {
                switchForm('welcome');
            }, 1000);
        } else {
            if (data.similarity !== undefined) {
                updateSimilarityBar(data.similarity);
            }
            if (data.similarity < 75) {
                alert('La similitud de voz es muy baja. Se requiere al menos 75% de similitud.');
            } else {
                alert(data.error || 'Error en el inicio de sesión');
            }
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error en el inicio de sesión');
    }
}

// Función para limpiar datos
function clearAuthData() {
    currentVoicePhrase = '';
    isRecording = false;
    audioBlob = null;
    audioChunks = [];
    
    document.getElementById('loginUsername').value = '';
    document.getElementById('registerUsername').value = '';
    
    loginVoiceStatus.textContent = '';
    registerVoiceStatus.textContent = '';
    
    const container = document.querySelector('.similarity-container');
    if (container) {
        container.style.display = 'none';
    }
    
    document.querySelector('.voice-input-container').classList.remove('recording');
}

// Event listeners para botones de formulario
registerButton.addEventListener('click', register);
loginButton.addEventListener('click', login);
logoutButton.addEventListener('click', () => {
    localStorage.removeItem('token');
    clearAuthData();
    switchForm('login');
});

// Verificar sesión al cargar
const token = localStorage.getItem('token');
if (token) {
    switchForm('welcome');
} else {
    clearAuthData();
    switchForm('login');
}

// Inicializar el sistema de audio al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    initAudioSystem().catch(error => {
        console.error('Error initializing audio system:', error);
    });
}); 