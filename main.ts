import {
  Bot,
  Context,
  InlineKeyboard,
  webhookCallback,
} from "https://deno.land/x/grammy@v1.25.1/mod.ts";

// --- 1. Configuration & Setup ---

const BOT_TOKEN = "7936487928:AAENklfHmE5uLadTmB3wzqqEK4nWprIqLEY";
const ADMIN_ID = "1908801848";

const kv = await Deno.openKv();
const bot = new Bot(BOT_TOKEN);

type UserDetails = {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
};

// --- 2. Menu Building Functions ---

// Main Menu
function buildMainMenu(isAdmin: boolean) {
    const text = isAdmin 
        ? `👑 **Admin Panel**\n\nWelcome, Administrator! Please choose an option below.`
        : `👋 **Welcome!**\n\nI can process VCF contact files. To get started, please request access.`;
    
    const keyboard = new InlineKeyboard();

    if (isAdmin) {
        keyboard.text("View Pending Requests", "view_requests").row();
        keyboard.text("Manage Whitelisted Users", "manage_users").row();
        // ADDED a button for clearing the whitelist
        keyboard.text("⚠️ Clear Whitelist", "confirm_clear_menu").row();
    } else {
        keyboard.text("➡️ Request Access", "request_access").row();
    }
    return { text, keyboard };
}

// Menu for Pending Requests
async function buildRequestsMenu() {
    // ... (This function is unchanged)
    const entries = kv.list<UserDetails>({ prefix: ["pending"] });
    const pendingUsers: UserDetails[] = [];
    for await (const entry of entries) pendingUsers.push(entry.value);
    if (pendingUsers.length === 0) return { text: "✅ No pending access requests.", keyboard: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu") };
    let text = `<b>Pending Access Requests (${pendingUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    pendingUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n`;
        keyboard.text(`✅ Approve ${user.firstName}`, `approve_${user.id}`).text(`❌ Reject ${user.firstName}`, `reject_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

// Menu for Managing Whitelisted Users
async function buildWhitelistMenu() {
    // ... (This function is unchanged)
    const entries = kv.list<UserDetails>({ prefix: ["whitelist"] });
    const whitelistedUsers: UserDetails[] = [];
    for await (const entry of entries) {
        if (typeof entry.value === 'object' && entry.value !== null) whitelistedUsers.push(entry.value);
    }
    if (whitelistedUsers.length === 0) return { text: "✅ The user whitelist is currently empty.", keyboard: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu") };
    let text = `<b>Manage Whitelisted Users (${whitelistedUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    whitelistedUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n`;
        keyboard.text(`🗑️ Remove ${user.firstName}`, `remove_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

// NEW MENU for the confirmation screen
function buildClearConfirmationMenu() {
    const text = "⚠️ **DANGER ZONE** ⚠️\n\nAre you sure you want to clear the entire user whitelist?\n\nThis action cannot be undone.";
    const keyboard = new InlineKeyboard()
        .text("🔴 Yes, I am sure. Clear It.", "do_clear_whitelist")
        .row()
        .text("⬅️ No, Go Back to Menu", "main_menu");
    return { text, keyboard };
}


// --- 3. Whitelisting Middleware ---
// (No changes needed here)
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() === ADMIN_ID) return next();
  if (ctx.callbackQuery) return next(); 
  const command = ctx.message?.text?.split(" ")[0];
  if (command === "/start" || command === "/myid") return next();
  const isWhitelisted = (await kv.get(["whitelist", ctx.from!.id])).value;
  if (isWhitelisted) {
    await next();
  } else {
    await ctx.reply("❌ You are not authorized. Please request access from the main menu.", {
        reply_markup: new InlineKeyboard().text("➡️ Request Access", "request_access")
    });
  }
});


// --- 4. Command and Callback Handlers ---

bot.command("start", async (ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    const { text, keyboard } = buildMainMenu(isAdmin);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("myid", (ctx) => {
  ctx.reply(`Your Telegram User ID is: \`${ctx.from.id}\``, { parse_mode: "MarkdownV2" });
});

// The /clearwhitelist command is now handled by buttons, so we remove the text command handler.

// The Master Callback Handler for ALL button clicks
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    // --- Menu Navigation ---
    if (data === "main_menu") {
        const isAdmin = userId.toString() === ADMIN_ID;
        const { text, keyboard } = buildMainMenu(isAdmin);
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }

    if (data === "view_requests" && userId.toString() === ADMIN_ID) {
        const { text, keyboard } = await buildRequestsMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }
    
    if (data === "manage_users" && userId.toString() === ADMIN_ID) {
        const { text, keyboard } = await buildWhitelistMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }

    // --- Confirmation Menu Logic ---
    if (data === "confirm_clear_menu" && userId.toString() === ADMIN_ID) {
        const { text, keyboard } = buildClearConfirmationMenu();
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }

    // --- User Actions ---
    if (data === "request_access") {
        // ... (This logic is unchanged)
        const user = ctx.from;
        if (user.id.toString() === ADMIN_ID || (await kv.get(["whitelist", user.id])).value) {
            await ctx.answerCallbackQuery({ text: "✅ You are already authorized.", show_alert: true });
            return;
        }
        if ((await kv.get(["pending", user.id])).value) {
            await ctx.answerCallbackQuery({ text: "⏳ Your request is already pending.", show_alert: true });
            return;
        }
        const userDetails: UserDetails = { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username };
        await kv.set(["pending", user.id], userDetails);
        await ctx.answerCallbackQuery({ text: "✅ Your request has been submitted!", show_alert: true });
        await bot.api.sendMessage(ADMIN_ID, `🔔 New access request from ${user.first_name}. Use /start to view.`).catch(console.error);
        return;
    }

    // --- Admin Actions (Approve, Reject, Remove, and NOW Clear) ---
    if (userId.toString() !== ADMIN_ID) {
        await ctx.answerCallbackQuery({ text: "❌ Action not allowed." });
        return;
    }
    
    if (data === "do_clear_whitelist") {
        const entries = kv.list({ prefix: ["whitelist"] });
        let count = 0;
        for await (const entry of entries) {
            await kv.delete(entry.key);
            count++;
        }
        await ctx.editMessageText(`✅ Whitelist cleared. ${count} users have been removed.`, {
            reply_markup: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu")
        });
        await ctx.answerCallbackQuery({ text: "Whitelist successfully cleared." });
        return;
    }

    const [action, targetIdStr] = data.split("_");
    const targetId = parseInt(targetIdStr, 10);
    if (!targetId) return;

    if (action === "approve") {
        // ... (This logic is unchanged)
        const pendingUser = await kv.get<UserDetails>(["pending", targetId]);
        if (pendingUser.value) {
            await kv.delete(["pending", targetId]);
            await kv.set(["whitelist", targetId], pendingUser.value);
            await bot.api.sendMessage(targetId, "🎉 Your access request has been approved!").catch(console.error);
            await ctx.answerCallbackQuery({ text: `${pendingUser.value.firstName} approved.` });
            const { text, keyboard } = await buildRequestsMenu();
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    } else if (action === "reject") {
        // ... (This logic is unchanged)
        await kv.delete(["pending", targetId]);
        await bot.api.sendMessage(targetId, "😔 Your access request has been denied.").catch(console.error);
        await ctx.answerCallbackQuery({ text: "User rejected." });
        const { text, keyboard } = await buildRequestsMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } else if (action === "remove") {
        // ... (This logic is unchanged)
        const removedUser = await kv.get<UserDetails>(["whitelist", targetId]);
        await kv.delete(["whitelist", targetId]);
        await bot.api.sendMessage(targetId, "Your access to this bot has been revoked by the administrator.").catch(console.error);
        await ctx.answerCallbackQuery({ text: `${removedUser.value?.firstName || 'User'} has been removed.` });
        const { text, keyboard } = await buildWhitelistMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
});


// --- 5. VCF File Processing Logic ---
// (No changes needed here)
bot.on("message:document", async (ctx) => { /* ... */ });


// --- 6. Error Handling & Deployment ---
bot.catch((err) => console.error(`Error for update ${err.ctx.update.update_id}:`, err.error));
if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  Deno.serve(webhookCallback(bot, "std/http"));
} else {
  console.log("Bot starting...");
  bot.start();
}
