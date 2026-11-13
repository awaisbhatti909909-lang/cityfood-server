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
const POLL_INTERVAL = 1500;
let lastCheck = Date.now();

async function sendFCM({ token, topic, title, body, data, orderId }) {
  // Data-only on purpose: a top-level `notification` block lets the Android
  // system tray render the push directly while the app is killed, which
  // skips Flutter's background isolate entirely — the merchant/rider siren
  // and full-screen call UI never get a chance to run. Keeping everything
  // in `data` forces every push through _onBackgroundMessage.
  const message = {
    data: {
      ...data,
      title,
      body,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      priority: 'high',
      // Route through whichever channel the sender actually asked for
      // (e.g. delivery_high_alert_channel for new_order/available_order)
      // instead of always forcing the low-alert default channel.
      notification: {
        channelId: data?.channelId || 'cityfood_orders',
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

    // Dispatch every queued notification concurrently instead of one at a
    // time — with several riders queued for the same order, a sequential
    // loop made rider #5's push wait on riders #1-4's FCM round-trips first.
    await Promise.all(Object.entries(notifications).map(async ([notifId, notif]) => {
      if (notif.sent) return;

      console.log(`\n📨 Processing notification: "${notif.title}" (targetUid: ${notif.targetUid || 'none'}, topic: ${notif.topic || 'none'})`);

      let targetToken = notif.token;

      // If token is missing but targetUid is specified, look up the user's current token from RTDB
      if (!targetToken && notif.targetUid) {
        try {
          const userSnap = await db.ref(`users/${notif.targetUid}/fcmToken`).once('value');
          targetToken = userSnap.val();
        } catch (e) {
          console.error(`Failed to fetch token for user ${notif.targetUid}:`, e.message);
        }
      }

      // 1. Direct device push (Single user: customer, rider, or merchant)
      if (targetToken) {
        await sendFCM({
          token: targetToken,
          title: notif.title,
          body: notif.body,
          data: notif.data || {},
          orderId: notif.data?.orderId,
        });
      } 
      // 2. Broadcast to Topic ONLY if:
      // - No single target token was specified
      // - AND the topic is NOT 'customer_updates' (never broadcast private customer order status to all customers!)
      else if (notif.topic && notif.topic !== 'customer_updates') {
        await sendFCM({
          topic: notif.topic,
          title: notif.title,
          body: notif.body,
          data: notif.data || {},
          orderId: notif.data?.orderId,
        });
      } else {
        console.log(`⚠️ Skipped broadcast for private/unroutable notification: ${notif.title}`);
      }

      await db.ref(`notificationQueue/${notifId}/sent`).set(true);
      await db.ref(`notificationQueue/${notifId}/sentAt`).set(new Date().toISOString());
    }));

    lastCheck = Date.now();
  } catch (error) {
    // Silence
  }
}

// Health check endpoint for Render
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', project: serviceAccount.project_id }));
  } else if (parsedUrl.pathname === '/api/customer-stats') {
    try {
      const usersSnap = await db.ref('users').once('value');
      let totalCustomers = 0;
      let activeTokens = 0;
      if (usersSnap.exists()) {
        usersSnap.forEach(child => {
          const u = child.val();
          if (!u.role || u.role === 'customer') {
            totalCustomers++;
            if (u.fcmToken && u.fcmToken.trim().length > 10) {
              activeTokens++;
            }
          }
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, totalCustomers, activeTokens }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (parsedUrl.pathname === '/api/broadcast-promo' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        if (payload.secret !== 'cityfood909_live_secret') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized broadcast request' }));
        }

        const title = payload.title || '🍕 30% Bumper Discount Offer!';
        const messageBody = payload.body || "Rs 1,000 ka Pizza ab sirf Rs 700 mein! Promo Code 'CITYFOOD30' lagayein aur 30% discount payein. Abhi order karein!";

        const usersSnap = await db.ref('users').once('value');
        const customerList = [];
        if (usersSnap.exists()) {
          usersSnap.forEach(child => {
            const u = child.val();
            if ((!u.role || u.role === 'customer') && u.fcmToken && u.fcmToken.trim().length > 10) {
              customerList.push({ uid: child.key, token: u.fcmToken });
            }
          });
        }

        console.log(`📢 Starting broadcast push to ${customerList.length} customer devices...`);

        const results = await Promise.allSettled(customerList.map(c =>
          sendFCM({
            token: c.token,
            title,
            body: messageBody,
            data: {
              type: 'promo',
              promoCode: 'CITYFOOD30',
              channelId: 'cityfood_orders',
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
            },
          })
        ));

        const sent = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`✅ Broadcast complete: ${sent} sent, ${failed} failed.`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          totalCustomersFound: customerList.length,
          sent,
          failed,
        }));
      } catch (err) {
        console.error('Broadcast error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (parsedUrl.pathname === '/api/admin/order' && req.method === 'GET') {
    try {
      const orderNum = parsedUrl.searchParams.get('orderNumber');
      if (!orderNum) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'orderNumber query parameter is required' }));
      }

      const cleanTarget = String(orderNum).replace(/#/g, '').trim();
      const ordersSnap = await db.ref('orders').once('value');
      let foundOrder = null;
      let foundId = null;

      if (ordersSnap.exists()) {
        ordersSnap.forEach(child => {
          const o = child.val();
          const cleanNum = String(o.orderNumber || '').replace(/#/g, '').trim();
          if (cleanNum === cleanTarget || child.key === cleanTarget) {
            foundOrder = o;
            foundId = child.key;
          }
        });
      }

      if (!foundOrder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Order #${orderNum} not found` }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, orderId: foundId, order: foundOrder }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (parsedUrl.pathname === '/api/admin/deliver-order' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        if (payload.secret !== 'cityfood909_live_secret') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        const orderNum = payload.orderNumber;
        if (!orderNum) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'orderNumber is required' }));
        }

        const cleanTarget = String(orderNum).replace(/#/g, '').trim();
        const ordersSnap = await db.ref('orders').once('value');
        let matchedOrderId = null;
        let matchedOrder = null;

        if (ordersSnap.exists()) {
          ordersSnap.forEach(child => {
            const o = child.val();
            const cleanNum = String(o.orderNumber || '').replace(/#/g, '').trim();
            if (cleanNum === cleanTarget || child.key === cleanTarget) {
              matchedOrderId = child.key;
              matchedOrder = o;
            }
          });
        }

        if (!matchedOrderId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Order #${orderNum} not found` }));
        }

        const now = new Date().toISOString();
        const amountCollected = payload.amountCollected !== undefined 
          ? Number(payload.amountCollected) 
          : Number(matchedOrder.total || 419);

        const updates = {
          status: 'delivered',
          paid: true,
          amountCollected: amountCollected,
          deliveredAt: now,
          riderEarningApplied: true,
          riderEarningCleared: false,
        };

        if (!matchedOrder.acceptedAt) updates.acceptedAt = now;
        if (!matchedOrder.readyAt) updates.readyAt = now;
        if (matchedOrder.riderId && !matchedOrder.assignedAt) updates.assignedAt = now;
        if (!matchedOrder.pickedUpAt) updates.pickedUpAt = now;

        await db.ref(`orders/${matchedOrderId}`).update(updates);
        console.log(`✅ Order #${cleanTarget} (${matchedOrderId}) marked DELIVERED.`);

        // Notify customer of delivery directly
        if (matchedOrder.customerId) {
          try {
            const custSnap = await db.ref(`users/${matchedOrder.customerId}/fcmToken`).once('value');
            const custToken = custSnap.val();
            if (custToken) {
              await sendFCM({
                token: custToken,
                title: 'Order Delivered!',
                body: `Order #${cleanTarget} has been delivered. Enjoy your meal!`,
                data: {
                  type: 'order_delivered',
                  orderId: matchedOrderId,
                  channelId: 'cityfood_orders',
                },
                orderId: matchedOrderId,
              });
            }
          } catch (e) {
            console.error('Failed to notify customer:', e.message);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          orderId: matchedOrderId,
          orderNumber: matchedOrder.orderNumber,
          customerName: matchedOrder.customerName,
          status: 'delivered',
          amountCollected,
          updatedFields: updates
        }));
      } catch (err) {
        console.error('Deliver order error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
