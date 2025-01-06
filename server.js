const aedes = require("aedes")();
const net = require("net");
const http = require("http");
const prisma = require("./utils/db"); // Prisma client instance
const jwt = require("jsonwebtoken"); // Menambahkan jwt untuk verifikasi token
const express = require("express");
const ws = require("websocket-stream");
const { updateStatusDevice, signInDeviceFunction } = require("./utils/utils");
const cors = require("cors");
const mqttServer = net.createServer(aedes.handle);
const websocketServer = http.createServer();
const app = express();
const port = 3001;

const MQTT_PORT = process.env.MQTT_PORT || 1883;
const WS_PORT = process.env.WS_PORT || 8883;
const JWT_SECRET =
  process.env.JWT_SECRET || "B1?uP4HnXLcYH[/kWCNpE]AbVcD(h]+,*vq"; // Secret untuk JWT

ws.createServer({ server: websocketServer }, aedes.handle);

let loginAttempts = new Map(); // Map untuk melacak percakapan login

async function authenticate(client, username, password, callback) {
  if (!username) return callback(null, false);

  const MAX_ATTEMPTS = 10;
  const BLOCK_DURATION = 60000; // 60 detik
  const now = Date.now();
  let attemptsData = loginAttempts.get(username) || {
    attempts: 0,
    lastAttempt: 0,
  };

  if (
    attemptsData.attempts >= MAX_ATTEMPTS &&
    now - attemptsData.lastAttempt < BLOCK_DURATION
  ) {
    console.warn(`[AUTH] Authentication blocked for ${username}`);
    return callback(null, false);
  }

  if (now - attemptsData.lastAttempt > BLOCK_DURATION) {
    attemptsData = { attempts: 1, lastAttempt: now };
  } else {
    attemptsData.attempts += 1;
    attemptsData.lastAttempt = now;
  }

  loginAttempts.set(username, attemptsData);

  try {
    if (client.id.startsWith("DEVICE-")) {
      const login = await signInDeviceFunction(username, password);
      if (login) loginAttempts.delete(username);
      return callback(null, login);
    }

    const dataUser = await prisma.user.findUnique({ where: { username } });
    if (!dataUser) return callback(null, false);

    const decoded = jwt.verify(dataUser.token, JWT_SECRET);
    if (!decoded) return callback(null, false);

    const tokenMatch =
      decoded.username === username && decoded.role === password.toString();
    if (tokenMatch) {
      loginAttempts.delete(username);
      return callback(null, true);
    }

    return callback(null, false);
  } catch (error) {
    console.error(`[AUTH] Error during authentication: ${error.message}`);
    return callback(error, false);
  }
}

aedes.authenticate = authenticate;

aedes.on("publish", async (packet, client) => {
  const topicParts = packet.topic.split("/");
  if (topicParts.length === 2) {
    const deviceId = topicParts[0];
    const virtualPinId = topicParts[1];
    const value = packet.payload.toString(); // Ambil nilai payload dari pesan yang diterima

    try {
      // Mencari device berdasarkan deviceId dan virtualpin terkait
      const device = await prisma.devices.findUnique({
        where: { id: deviceId },
        include: { virtualpin: true }, // Sertakan virtualpin terkait
      });

      if (device) {
        // Validasi apakah virtualPinId ada pada daftar virtualpin untuk device ini
        const validPin = device.virtualpin.find(
          (pin) => pin.id === virtualPinId
        );
        if (validPin) {
          // Jika virtual pin valid, lakukan pembaruan data pada Virtualpin
          const updatedVirtualpin = await prisma.virtualpin.update({
            where: { id: virtualPinId },
            data: {
              data: value, // Update data pada Virtualpin
            },
          });

          console.log(
            `Data untuk ${deviceId}/${virtualPinId} berhasil diperbarui: ${updatedVirtualpin.data}`
          );
        } else if (virtualPinId == "status") {
          updateStatusDevice(deviceId, value);
          sendEvent()
        } else {
          console.log(
            `Virtual pin ID ${virtualPinId} tidak valid untuk device ${deviceId}`
          );
        }
      } else {
        console.log(`Device dengan ID ${deviceId} tidak ditemukan`);
      }
    } catch (error) {
      console.error("Error while verifying or updating data:", error);
    }
  }
});

let clients = []; // Array untuk menyimpan koneksi klien

// Fungsi untuk mengirimkan event ke klien
function sendEvent() {
  clients.forEach((client, index) => {
    try {
      client.res.write(`data: devices update\n\n`); // Format SSE harus benar
      console.log("Event sent to client");
    } catch (error) {
      console.error("Error sending event to client:", error);
      clients.splice(index, 1); // Hapus koneksi bermasalah
    }
  });
}

// Middleware CORS
app.use(
  cors({
    methods: ["GET"], // SSE hanya menggunakan metode GET
    allowedHeaders: ["Content-Type"],
    exposedHeaders: ["Content-Type"],
  })
);

// Endpoint untuk Server-Sent Events
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Menyimpan koneksi klien
  clients.push({ res });

  let version = 1;
  let currentVersion = version;

  // Mengirim update jika ada perubahan data
  const interval = setInterval(() => {
    if (version !== currentVersion) {
      currentVersion = version;
      res.write(`data: update\n\n`); // Kirim event hanya jika ada perubahan
    }
  }, 1000);

  // Menghapus interval ketika koneksi ditutup
  req.on("close", () => {
    clearInterval(interval);
    clients = clients.filter((client) => client.res !== res); // Hapus klien dari daftar
    console.log("Client disconnected, remaining clients:", clients.length);
  });
});

// Fungsi untuk memperbarui status perangkat
function updateDeviceStatus(client, status) {
  aedes.publish({
    topic: `${client.id.replace("DEVICE-", "")}/status`,
    payload: status,
    retain: true,
  });
  updateStatusDevice(client.id, status);
}

// Event MQTT untuk koneksi klien
aedes.on("clientReady", (client) => {
  console.log(`Client connected: ${client.id}`);
  if (client.id.startsWith("DEVICE-")) {
    updateDeviceStatus(client, "online");
  }
});

aedes.on("clientDisconnect", (client) => {
  console.log(`Client disconnected: ${client.id}`);
  if (client.id.startsWith("DEVICE-")) {
    updateDeviceStatus(client, "offline");
  }
});

// Membuat server MQTT melalui TCP pada worker
mqttServer.listen(MQTT_PORT, () => {
  console.log(`[WORKER] MQTT SERVER RUNNING ON PORT ${MQTT_PORT}`);
});

// Membuat HTTP server untuk WebSocket pada worker
websocketServer.listen(WS_PORT, function () {
  console.log("[WORKER] WebSocket Server Running on port " + WS_PORT);
});

// Menjalankan API Express
app.listen(port, () => {
  console.log(`[WORKER] API RUNNING ON PORT ${port}`);
});
