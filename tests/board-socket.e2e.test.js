import request from "supertest";
import { io as ioc } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, httpServer } from "../server.js";

async function signupUser(suffix) {
  const username = `e2e${suffix}`;
  const res = await request(app)
    .post("/signup")
    .set("x-vz-device-id", `e2e-dev-${suffix}-${Date.now()}`)
    .send({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
      region: "Zemgale",
    });
  expect(res.status).toBe(200);
  expect(typeof res.body?.token).toBe("string");
  return { username, token: res.body.token };
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 10000,
    });
    const t = setTimeout(() => {
      socket.close();
      reject(new Error("socket connect timeout"));
    }, 12000);
    socket.once("connect", () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(t);
      socket.close();
      reject(err || new Error("connect_error"));
    });
  });
}

describe("Board socket E2E (chess draw)", () => {
  let port;

  beforeAll(async () => {
    await new Promise((resolve, reject) => {
      httpServer.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    const addr = httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : null;
    expect(port).toBeTruthy();
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("PvP accepts draw agreement when accepter is not on move (FIDE-style)", async () => {
    const u1 = await signupUser(`w${Date.now()}`);
    const u2 = await signupUser(`b${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", { target: u2.username, type: "chess" });
    });
    expect(inviteId.length).toBeGreaterThan(4);

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 10000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "chess",
      });
    });

    const gameId = start?.gameId;
    expect(typeof gameId).toBe("string");
    expect(start?.players?.[0]).toBe(u1.username);

    s1.emit("board.chessDrawOffer", { gameId });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("chessDrawState timeout")), 8000);
      s2.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        const from = payload?.chessDrawState?.drawOfferFrom;
        if (String(from).toLowerCase() === u1.username.toLowerCase()) resolve();
        else reject(new Error("unexpected draw offer state"));
      });
    });

    s2.emit("board.chessDrawAccept", { gameId });

    await Promise.all([
      new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.end s1")), 8000);
        s1.once("board.end", (p) => {
          clearTimeout(to);
          expect(p?.reason).toBe("draw_agreement");
          resolve();
        });
      }),
      new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("board.end s2")), 8000);
        s2.once("board.end", (p) => {
          clearTimeout(to);
          expect(p?.reason).toBe("draw_agreement");
          resolve();
        });
      }),
    ]);

    s1.close();
    s2.close();
  });

  it("chessDrawDecline clears an active offer", async () => {
    const u1 = await signupUser(`wd${Date.now()}`);
    const u2 = await signupUser(`bd${Date.now()}`);

    const s1 = await connectClient(port, u1.token);
    const s2 = await connectClient(port, u2.token);

    const inviteId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("invite timeout")), 10000);
      s2.once("board.invite", (p) => {
        clearTimeout(to);
        resolve(String(p?.inviteId || "").trim());
      });
      s1.emit("board.invite", { target: u2.username, type: "chess" });
    });

    const start = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("board.start timeout")), 10000);
      s1.once("board.start", (p) => {
        clearTimeout(to);
        resolve(p);
      });
      s2.emit("board.accept", {
        inviteId,
        from: u1.username,
        type: "chess",
      });
    });

    const gameId = start?.gameId;
    s1.emit("board.chessDrawOffer", { gameId });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("wait offer")), 8000);
      s2.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        if (payload?.chessDrawState?.drawOfferFrom) resolve();
        else reject(new Error("expected offer"));
      });
    });

    s2.emit("board.chessDrawDecline", { gameId });

    const cleared = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("clear timeout")), 8000);
      s1.once("board.chessDrawState", (payload) => {
        clearTimeout(to);
        resolve(!payload?.chessDrawState?.drawOfferFrom);
      });
    });
    expect(cleared).toBe(true);

    s1.close();
    s2.close();
  });
});
