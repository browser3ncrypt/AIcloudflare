import {
        type Connection,
        Server,
        type WSMessage,
        routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

// Extend your Message type if needed in ../shared, or just handle it here
// For now we handle the new type inline

export class Chat extends Server<Env> {
        static options = { hibernate: true };

        messages = [] as ChatMessage[];
        likes = 0;                              // ← NEW: shared like counter

        broadcastMessage(message: Message, exclude?: string[]) {
                this.broadcast(JSON.stringify(message), exclude);
        }

        async onStart() {
                // Create messages table
                this.ctx.storage.sql.exec(
                        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
                );

                // NEW: Create likes table (simple key-value)
                this.ctx.storage.sql.exec(
                        `CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER)`,
                );

                // Load previous messages
                this.messages = this.ctx.storage.sql
                        .exec(`SELECT * FROM messages`)
                        .toArray() as ChatMessage[];

                // Load likes count
                const row = this.ctx.storage.sql
                        .exec(`SELECT value FROM metadata WHERE key = 'likes'`)
                        .one();
                if (row) {
                        this.likes = row.value as number;
                }

                // Broadcast current likes to any early connections (optional but nice)
                this.broadcastMessage({ type: "likes", count: this.likes });
        }

        onConnect(connection: Connection) {
                // Send all existing chat messages
                connection.send(
                        JSON.stringify({
                                type: "all",
                                messages: this.messages,
                        } satisfies Message),
                );

                // NEW: Also send current like count to the new user
                connection.send(
                        JSON.stringify({ type: "likes", count: this.likes }),
                );
        }

        saveMessage(message: ChatMessage) {
                const existingMessage = this.messages.find((m) => m.id === message.id);
                if (existingMessage) {
                        this.messages = this.messages.map((m) =>
                                m.id === message.id ? message : m,
                        );
                } else {
                        this.messages.push(message);
                }

                this.ctx.storage.sql.exec(
                        `INSERT INTO messages (id, user, role, content) 
                         VALUES ('\( {message.id}', ' \){message.user}', '${message.role}', ${JSON.stringify(message.content)}) 
                         ON CONFLICT (id) DO UPDATE SET content = ${JSON.stringify(message.content)}`,
                );
        }

        // NEW: Persist likes count
        private saveLikes() {
                this.ctx.storage.sql.exec(
                        `INSERT INTO metadata (key, value) VALUES ('likes', ${this.likes}) 
                         ON CONFLICT (key) DO UPDATE SET value = ${this.likes}`,
                );
        }

        onMessage(connection: Connection, message: WSMessage) {
                const raw = message as string;
                this.broadcast(raw); // Echo to all clients (including sender)

                try {
                        const parsed = JSON.parse(raw) as Message;

                        // Handle existing chat messages
                        if (parsed.type === "add" || parsed.type === "update") {
                                this.saveMessage(parsed);
                        }

                        // NEW: Handle like button clicks
                        if (parsed.type === "like") {
                                this.likes++;
                                this.saveLikes();

                                // Broadcast updated count to everyone
                                this.broadcastMessage({
                                        type: "likes",
                                        count: this.likes,
                                });
                        }
                } catch (e) {
                        // Invalid JSON – ignore or log
                        console.error("Invalid message:", e);
                }
        }
}

export default {
        async fetch(request, env) {
                return (
                        (await routePartykitRequest(request, { ...env })) ||
                        env.ASSETS.fetch(request)
                );
        },
} satisfies ExportedHandler<Env>;