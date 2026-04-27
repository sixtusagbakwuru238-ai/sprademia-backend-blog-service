// src/lib/message-bus.ts
// RabbitMQ wrapper for publishing and consuming events.
// This service PUBLISHES blog events (post published, comment created, etc.)
// and CONSUMES user events (user.profile.updated) from the Auth service.

import amqplib, { type Channel, type Connection, type ConsumeMessage } from "amqplib";
import { config } from "../config";
import type { BlogEvent, BlogEventType } from "../types";

let connection: Connection | null = null;
let publishChannel: Channel | null = null;
let consumeChannel: Channel | null = null;

const RECONNECT_DELAY_MS = 5000;

async function connect(): Promise<void> {
  try {
    connection = await amqplib.connect(config.RABBITMQ_URL);

    connection.on("error", (err) => {
      console.error("[RabbitMQ] Connection error:", err.message);
    });

    connection.on("close", () => {
      console.warn("[RabbitMQ] Connection closed. Reconnecting in 5s…");
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    publishChannel = await connection.createChannel();
    consumeChannel = await connection.createChannel();

    // Assert the main topic exchange
    await publishChannel.assertExchange(
      config.RABBITMQ_EXCHANGE,
      "topic",
      { durable: true }
    );
    await consumeChannel.assertExchange(
      config.RABBITMQ_EXCHANGE,
      "topic",
      { durable: true }
    );

    // Prefetch 10 messages at a time on the consume channel
    await consumeChannel.prefetch(10);

    console.info("[RabbitMQ] Connected and channels ready");
  } catch (err) {
    console.error("[RabbitMQ] Failed to connect:", (err as Error).message);
    setTimeout(connect, RECONNECT_DELAY_MS);
  }
}

export async function connectMessageBus(): Promise<void> {
  await connect();
}

export async function disconnectMessageBus(): Promise<void> {
  try {
    await publishChannel?.close();
    await consumeChannel?.close();
    await connection?.close();
  } catch {
    // Ignore close errors on shutdown
  }
}

// ─────────────────────────────────────────────────────────────────────
// Publish a blog domain event
// ─────────────────────────────────────────────────────────────────────

export async function publish<T>(
  eventType: BlogEventType,
  payload: T
): Promise<void> {
  if (!publishChannel) {
    console.warn("[RabbitMQ] Publish channel not ready — event dropped:", eventType);
    return;
  }

  const event: BlogEvent<T> = {
    eventType,
    serviceSource: "blog-service",
    timestamp: new Date().toISOString(),
    payload,
  };

  const routingKey = eventType; // e.g. "blog.post.published"

  publishChannel.publish(
    config.RABBITMQ_EXCHANGE,
    routingKey,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,        // survive broker restart
      contentType: "application/json",
      timestamp: Date.now(),
    }
  );
}

// ─────────────────────────────────────────────────────────────────────
// Subscribe to events from other services
// ─────────────────────────────────────────────────────────────────────

type MessageHandler = (content: unknown) => Promise<void>;

export async function subscribe(
  queueName: string,
  routingPattern: string,
  handler: MessageHandler
): Promise<void> {
  if (!consumeChannel) {
    throw new Error("[RabbitMQ] Consume channel not ready");
  }

  await consumeChannel.assertQueue(queueName, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": `${config.RABBITMQ_EXCHANGE}.dlx`,
      "x-message-ttl": 86_400_000, // 24h TTL
    },
  });

  await consumeChannel.bindQueue(
    queueName,
    config.RABBITMQ_EXCHANGE,
    routingPattern
  );

  await consumeChannel.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    try {
      const content = JSON.parse(msg.content.toString());
      await handler(content);
      consumeChannel!.ack(msg);
    } catch (err) {
      console.error("[RabbitMQ] Handler error:", (err as Error).message);
      // Nack with requeue=false → goes to dead-letter queue after 3 attempts
      consumeChannel!.nack(msg, false, false);
    }
  });
}



// // src/lib/message-bus.ts
// // RabbitMQ wrapper for publishing and consuming events.
// // This service PUBLISHES blog events (post published, comment created, etc.)
// // and CONSUMES user events (user.profile.updated) from the Auth service.

// import amqplib, { type Channel, type Connection, type ConsumeMessage } from "amqplib";
// import { config } from "../config";
// import type { BlogEvent, BlogEventType } from "../types";

// let connection: Connection | null = null;
// let publishChannel: Channel | null = null;
// let consumeChannel: Channel | null = null;

// const RECONNECT_DELAY_MS = 5000;

// async function connect(): Promise<void> {
//   try {
//     connection = await amqplib.connect(config.RABBITMQ_URL);

//     connection.on("error", (err) => {
//       console.error("[RabbitMQ] Connection error:", err.message);
//     });

//     connection.on("close", () => {
//       console.warn("[RabbitMQ] Connection closed. Reconnecting in 5s…");
//       setTimeout(connect, RECONNECT_DELAY_MS);
//     });

//     publishChannel = await connection.createChannel();
//     consumeChannel = await connection.createChannel();

//     // Assert the main topic exchange
//     await publishChannel.assertExchange(
//       config.RABBITMQ_EXCHANGE,
//       "topic",
//       { durable: true }
//     );
//     await consumeChannel.assertExchange(
//       config.RABBITMQ_EXCHANGE,
//       "topic",
//       { durable: true }
//     );

//     // Prefetch 10 messages at a time on the consume channel
//     await consumeChannel.prefetch(10);

//     console.info("[RabbitMQ] Connected and channels ready");
//   } catch (err) {
//     console.error("[RabbitMQ] Failed to connect:", (err as Error).message);
//     setTimeout(connect, RECONNECT_DELAY_MS);
//   }
// }

// export async function connectMessageBus(): Promise<void> {
//   await connect();
// }

// export async function disconnectMessageBus(): Promise<void> {
//   try {
//     await publishChannel?.close();
//     await consumeChannel?.close();
//     await connection?.close();
//   } catch {
//     // Ignore close errors on shutdown
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Publish a blog domain event
// // ─────────────────────────────────────────────────────────────────────

// export async function publish<T>(
//   eventType: BlogEventType,
//   payload: T
// ): Promise<void> {
//   if (!publishChannel) {
//     console.warn("[RabbitMQ] Publish channel not ready — event dropped:", eventType);
//     return;
//   }

//   const event: BlogEvent<T> = {
//     eventType,
//     serviceSource: "blog-service",
//     timestamp: new Date().toISOString(),
//     payload,
//   };

//   const routingKey = eventType; // e.g. "blog.post.published"

//   publishChannel.publish(
//     config.RABBITMQ_EXCHANGE,
//     routingKey,
//     Buffer.from(JSON.stringify(event)),
//     {
//       persistent: true,        // survive broker restart
//       contentType: "application/json",
//       timestamp: Date.now(),
//     }
//   );
// }

// // ─────────────────────────────────────────────────────────────────────
// // Subscribe to events from other services
// // ─────────────────────────────────────────────────────────────────────

// type MessageHandler = (content: unknown) => Promise<void>;

// export async function subscribe(
//   queueName: string,
//   routingPattern: string,
//   handler: MessageHandler
// ): Promise<void> {
//   if (!consumeChannel) {
//     throw new Error("[RabbitMQ] Consume channel not ready");
//   }

//   await consumeChannel.assertQueue(queueName, {
//     durable: true,
//     arguments: {
//       "x-dead-letter-exchange": `${config.RABBITMQ_EXCHANGE}.dlx`,
//       "x-message-ttl": 86_400_000, // 24h TTL
//     },
//   });

//   await consumeChannel.bindQueue(
//     queueName,
//     config.RABBITMQ_EXCHANGE,
//     routingPattern
//   );

//   await consumeChannel.consume(queueName, async (msg: ConsumeMessage | null) => {
//     if (!msg) return;
//     try {
//       const content = JSON.parse(msg.content.toString());
//       await handler(content);
//       consumeChannel!.ack(msg);
//     } catch (err) {
//       console.error("[RabbitMQ] Handler error:", (err as Error).message);
//       // Nack with requeue=false → goes to dead-letter queue after 3 attempts
//       consumeChannel!.nack(msg, false, false);
//     }
//   });
// }


// // src/lib/message-bus.ts
// // RabbitMQ wrapper for publishing and consuming events.
// // This service PUBLISHES blog events (post published, comment created, etc.)
// // and CONSUMES user events (user.profile.updated) from the Auth service.

// import amqplib, { type Channel, type Connection, type ConsumeMessage } from "amqplib";
// import { config } from "../config";
// import type { BlogEvent, BlogEventType } from "../types";

// let connection: Connection | null = null;
// let publishChannel: Channel | null = null;
// let consumeChannel: Channel | null = null;

// const RECONNECT_DELAY_MS = 5000;

// async function connect(): Promise<void> {
//   try {
//     connection = await amqplib.connect(config.RABBITMQ_URL);

//     connection.on("error", (err) => {
//       console.error("[RabbitMQ] Connection error:", err.message);
//     });

//     connection.on("close", () => {
//       console.warn("[RabbitMQ] Connection closed. Reconnecting in 5s…");
//       setTimeout(connect, RECONNECT_DELAY_MS);
//     });

//     publishChannel = await connection.createChannel();
//     consumeChannel = await connection.createChannel();

//     // Assert the main topic exchange
//     await publishChannel.assertExchange(
//       config.RABBITMQ_EXCHANGE,
//       "topic",
//       { durable: true }
//     );
//     await consumeChannel.assertExchange(
//       config.RABBITMQ_EXCHANGE,
//       "topic",
//       { durable: true }
//     );

//     // Prefetch 10 messages at a time on the consume channel
//     await consumeChannel.prefetch(10);

//     console.info("[RabbitMQ] Connected and channels ready");
//   } catch (err) {
//     console.error("[RabbitMQ] Failed to connect:", (err as Error).message);
//     setTimeout(connect, RECONNECT_DELAY_MS);
//   }
// }

// export async function connectMessageBus(): Promise<void> {
//   await connect();
// }

// export async function disconnectMessageBus(): Promise<void> {
//   try {
//     await publishChannel?.close();
//     await consumeChannel?.close();
//     await connection?.close();
//   } catch {
//     // Ignore close errors on shutdown
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Publish a blog domain event
// // ─────────────────────────────────────────────────────────────────────

// export async function publish<T>(
//   eventType: BlogEventType,
//   payload: T
// ): Promise<void> {
//   if (!publishChannel) {
//     console.warn("[RabbitMQ] Publish channel not ready — event dropped:", eventType);
//     return;
//   }

//   const event: BlogEvent<T> = {
//     eventType,
//     serviceSource: "blog-service",
//     timestamp: new Date().toISOString(),
//     payload,
//   };

//   const routingKey = eventType; // e.g. "blog.post.published"

//   publishChannel.publish(
//     config.RABBITMQ_EXCHANGE,
//     routingKey,
//     Buffer.from(JSON.stringify(event)),
//     {
//       persistent: true,        // survive broker restart
//       contentType: "application/json",
//       timestamp: Date.now(),
//     }
//   );
// }

// // ─────────────────────────────────────────────────────────────────────
// // Subscribe to events from other services
// // ─────────────────────────────────────────────────────────────────────

// type MessageHandler = (content: unknown) => Promise<void>;

// export async function subscribe(
//   queueName: string,
//   routingPattern: string,
//   handler: MessageHandler
// ): Promise<void> {
//   if (!consumeChannel) {
//     throw new Error("[RabbitMQ] Consume channel not ready");
//   }

//   await consumeChannel.assertQueue(queueName, {
//     durable: true,
//     arguments: {
//       "x-dead-letter-exchange": `${config.RABBITMQ_EXCHANGE}.dlx`,
//       "x-message-ttl": 86_400_000, // 24h TTL
//     },
//   });

//   await consumeChannel.bindQueue(
//     queueName,
//     config.RABBITMQ_EXCHANGE,
//     routingPattern
//   );

//   await consumeChannel.consume(queueName, async (msg: ConsumeMessage | null) => {
//     if (!msg) return;
//     try {
//       const content = JSON.parse(msg.content.toString());
//       await handler(content);
//       consumeChannel!.ack(msg);
//     } catch (err) {
//       console.error("[RabbitMQ] Handler error:", (err as Error).message);
//       // Nack with requeue=false → goes to dead-letter queue after 3 attempts
//       consumeChannel!.nack(msg, false, false);
//     }
//   });
// }