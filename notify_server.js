// CityFood Notification Server — Render.com deployment
// Uses Firebase Admin SDK via service account (loaded from env var or file)

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Load service account — from env var (Render) or file (local)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  console.log('✅ Loaded service account from environment variable');
} else {
  const saPath = path.join(__dirname, 'city-food-7f19a-firebase-adminsdk-fbsvc-bf4fb64127.json');
  if (fs.existsSync(saPath)) {
    serviceAccount = require(saPath);
    console.log('✅ Loaded service account from file');
  } else {
    console.error('❌ No service account found! Set FIREBASE_SERVICE_ACCOUNT env var or place the JSON file.');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://city-food-7f19a-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = admin.database();
const messaging = admin.messaging();
const POLL_INTERVAL = 3000;
let lastCheck = Date.now();

async function sendFCM({ token, topic, title, body, data, orderId }) {
  const message = {
    notification: { title, body },
    data: {
      ...data,
      title,
      body,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'cityfood_orders',
        sound: 'order_alert',
      },
    },
  };

  if (token) {
    message.token = token;
  } else if (topic) {
    message.topic = topic;
  } else {
    console.log('⚠️ No token or topic');
    return null;
  }

  try {
    const result = await messaging.send(message);
    console.log(`✅ FCM sent: ${title}`);
    return result;
  } catch (error) {
    console.log(`❌ FCM error: ${error.message}`);
    return null;
  }
}

async function processQueue() {
  try {
    const startTime = new Date(Date.now() - 15000).toISOString();
    const snapshot = await db
      .ref('notificationQueue')
      .orderByChild('createdAt')
      .startAt(startTime)
      .once('value');

    if (!snapshot.exists()) return;
    const notifications = snapshot.val();

    for (const [notifId, notif] of Object.entries(notifications)) {
      if (notif.sent) continue;

      console.log(`\n📨 ${notif.title}`);

      if (notif.topic) {
        await sendFCM({
          topic: notif.topic,
          title: notif.title,
          body: notif.body,
          data: notif.data || {},
          orderId: notif.data?.orderId,
        });
      }

      if (notif.token) {
        await sendFCM({
          token: notif.token,
          title: notif.title,
          body: notif.body,
          data: notif.data || {},
          orderId: notif.data?.orderId,
        });
      }

      await db.ref(`notificationQueue/${notifId}/sent`).set(true);
      await db.ref(`notificationQueue/${notifId}/sentAt`).set(new Date().toISOString());
    }

    lastCheck = Date.now();
  } catch (error) {
    // Silence
  }
}

// Health check endpoint for Render
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', project: serviceAccount.project_id }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CityFood Notification Server is running');
  }
}).listen(PORT, () => {
  console.log(`🌐 Health check on port ${PORT}`);
});

console.log('🔔 CityFood Notification Server (Render)');
console.log(`📡 Project: ${serviceAccount.project_id}`);
console.log(`⏱️ Polling every ${POLL_INTERVAL / 1000}s...\n`);

processQueue();
setInterval(processQueue, POLL_INTERVAL);
