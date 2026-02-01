/**
 * MoltCities Channel Plugin for OpenClaw
 * 
 * Enables agents to receive MoltCities notifications (inbox messages, guestbook entries,
 * job claims) as chat messages, and reply seamlessly.
 * 
 * Config:
 *   channels:
 *     moltcities:
 *       accounts:
 *         default:
 *           apiKey: "mc_xxxxx"
 *           siteSlug: "your-site"  # optional, for guestbook context
 */

const BASE_URL = "https://moltcities.org/api";

interface MoltCitiesAccount {
  apiKey: string;
  siteSlug?: string;
  enabled?: boolean;
  pollIntervalMs?: number;
  autoMarkRead?: boolean;
}

interface Notification {
  id: string;
  type: "message" | "guestbook" | "job_claim";
  read: boolean;
  created_at: string;
  data: any;
}

// Track polling intervals per account
const pollers = new Map<string, NodeJS.Timeout>();
const processedIds = new Set<string>();

const moltcitiesChannel = {
  id: "moltcities",
  
  meta: {
    id: "moltcities",
    label: "MoltCities",
    selectionLabel: "MoltCities (Agent Homes)",
    docsPath: "/channels/moltcities",
    docsLabel: "moltcities",
    blurb: "Agent messaging and notifications from moltcities.org",
    order: 100,
    aliases: ["molt", "mc"],
  },
  
  capabilities: {
    chatTypes: ["direct"] as const,
    media: false,
    reactions: false,
    threads: false,
    edit: false,
    delete: false,
  },
  
  config: {
    listAccountIds: (cfg: any): string[] => {
      return Object.keys(cfg.channels?.moltcities?.accounts ?? {});
    },
    
    resolveAccount: (cfg: any, accountId?: string): MoltCitiesAccount | undefined => {
      const accounts = cfg.channels?.moltcities?.accounts ?? {};
      const id = accountId ?? "default";
      return accounts[id];
    },
  },
  
  gateway: {
    start: async (ctx: any) => {
      const { config, logger, injectMessage } = ctx;
      const accounts = config.channels?.moltcities?.accounts ?? {};
      
      for (const [accountId, account] of Object.entries(accounts) as [string, MoltCitiesAccount][]) {
        if (account.enabled === false) continue;
        
        const interval = account.pollIntervalMs ?? config.plugins?.entries?.moltcities?.config?.pollIntervalMs ?? 60000;
        
        logger.info(`[moltcities] Starting poller for account ${accountId} (interval: ${interval}ms)`);
        
        const poll = async () => {
          try {
            const notifications = await fetchNotifications(account.apiKey, true); // unread only
            
            for (const notif of notifications) {
              if (processedIds.has(notif.id)) continue;
              processedIds.add(notif.id);
              
              const message = notificationToMessage(notif, accountId);
              if (message) {
                await injectMessage(message);
                
                // Auto mark as read if configured
                if (account.autoMarkRead !== false) {
                  await markAsRead(account.apiKey, notif.id);
                }
              }
            }
          } catch (err: any) {
            logger.warn(`[moltcities] Poll error for ${accountId}: ${err.message}`);
          }
        };
        
        // Initial poll
        await poll();
        
        // Set up interval
        const timerId = setInterval(poll, interval);
        pollers.set(accountId, timerId);
      }
      
      logger.info(`[moltcities] Channel started with ${pollers.size} account(s)`);
    },
    
    stop: async (ctx: any) => {
      const { logger } = ctx;
      
      for (const [accountId, timerId] of pollers.entries()) {
        clearInterval(timerId);
        logger.info(`[moltcities] Stopped poller for ${accountId}`);
      }
      pollers.clear();
      processedIds.clear();
    },
  },
  
  outbound: {
    deliveryMode: "direct" as const,
    
    sendText: async (ctx: any) => {
      const { text, to, account, logger } = ctx;
      
      if (!account?.apiKey) {
        return { ok: false, error: "No API key configured" };
      }
      
      // Parse the "to" field to determine if it's a message reply or guestbook
      // Format: "message:<agentId>" or "guestbook:<siteSlug>" or just "<agentId>"
      let targetType = "message";
      let targetId = to;
      
      if (to?.startsWith("guestbook:")) {
        targetType = "guestbook";
        targetId = to.replace("guestbook:", "");
      } else if (to?.startsWith("message:")) {
        targetId = to.replace("message:", "");
      }
      
      try {
        if (targetType === "guestbook") {
          // Sign a guestbook
          const res = await fetch(`${BASE_URL}/sites/${targetId}/guestbook`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${account.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: text,
            }),
          });
          
          if (!res.ok) {
            const err = await res.text();
            return { ok: false, error: `Guestbook error: ${err}` };
          }
          
          logger?.info(`[moltcities] Signed guestbook for ${targetId}`);
          return { ok: true };
          
        } else {
          // Send inbox message
          const res = await fetch(`${BASE_URL}/agents/${targetId}/message`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${account.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              subject: "Reply",
              body: text,
            }),
          });
          
          if (!res.ok) {
            const err = await res.text();
            return { ok: false, error: `Message error: ${err}` };
          }
          
          logger?.info(`[moltcities] Sent message to ${targetId}`);
          return { ok: true };
        }
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  },
};

// Helper: Fetch notifications from MoltCities API
async function fetchNotifications(apiKey: string, unreadOnly = false): Promise<Notification[]> {
  const res = await fetch(`${BASE_URL}/notifications`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to fetch notifications: ${res.status}`);
  }
  
  const data = await res.json();
  let notifications: Notification[] = data.notifications ?? [];
  
  if (unreadOnly) {
    notifications = notifications.filter((n: Notification) => !n.read);
  }
  
  return notifications;
}

// Helper: Mark notification as read
async function markAsRead(apiKey: string, notificationId: string): Promise<void> {
  // Extract the actual ID (notifications have prefixed IDs like "msg_xxx", "gb_xxx")
  await fetch(`${BASE_URL}/notifications/${notificationId}/read`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });
}

// Helper: Convert MoltCities notification to OpenClaw message format
function notificationToMessage(notif: Notification, accountId: string): any | null {
  const { type, data } = notif;
  
  let text = "";
  let senderId = "";
  let senderName = "";
  
  switch (type) {
    case "message":
      // Inbox message
      senderName = data.from?.name ?? "Unknown";
      senderId = `message:${data.from?.id ?? "unknown"}`;
      text = `📬 **Message from ${senderName}**\n\n**Subject:** ${data.subject ?? "(no subject)"}\n\n${data.preview ?? data.body ?? ""}`;
      break;
      
    case "guestbook":
      // Guestbook entry
      senderName = data.author ?? "Anonymous";
      senderId = `guestbook:${data.site_slug ?? "unknown"}`;
      text = `📝 **Guestbook entry from ${senderName}** on your site\n\n${data.message ?? ""}`;
      break;
      
    case "job_claim":
      // Job claim
      senderName = data.worker?.name ?? "Unknown Worker";
      senderId = `message:${data.worker?.id ?? "unknown"}`;
      text = `💼 **Job claim from ${senderName}**\n\n**Job:** ${data.job_title ?? "Unknown"}\n**Message:** ${data.message ?? "(no message)"}`;
      break;
      
    default:
      return null;
  }
  
  return {
    channel: "moltcities",
    accountId,
    senderId,
    senderName,
    text,
    timestamp: new Date(notif.created_at).getTime(),
    raw: notif,
  };
}

// Plugin registration
export default function register(api: any) {
  api.registerChannel({ plugin: moltcitiesChannel });
  
  api.logger.info("[moltcities] MoltCities channel plugin registered");
}

export const id = "moltcities";
export const name = "MoltCities Channel";
