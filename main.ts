import {
  Bot,
  Context,
  InlineKeyboard,
  webhookCallback,
} from "https://deno.land/x/grammy@v1.25.1/mod.ts";
import { type Chat } from "https://deno.land/x/grammy@v1.25.1/types.ts";

// --- 1. Configuration & Setup ---

const BOT_TOKEN = "7936487928:AAENklfHmE5uLadTmB3wzqqEK4nWprIqLEY"; // Replace with your Bot Token
const ADMIN_ID = "1908801848"; // Replace with your Telegram User ID

const kv = await Deno.openKv();
const bot = new Bot(BOT_TOKEN);

type UserDetails = {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
};

// --- 2. Menu Building Functions (Unchanged) ---

function buildMainMenu(isAdmin: boolean) {
    const text = isAdmin 
        ? `👑 **Admin Panel**\n\nWelcome, Administrator! Please choose an option below.`
        : `👋 **Welcome!**\n\nI can process VCF contact files. To get started, please request access.`;
    
    const keyboard = new InlineKeyboard();

    if (isAdmin) {
        keyboard.text("View Pending Requests", "view_requests").row();
        keyboard.text("➕ Add User", "add_user_manual").text("👥 Manage Users", "manage_users").row();
        keyboard.text("⚠️ Clear Whitelist", "confirm_clear_menu").row();
    } else {
        keyboard.text("➡️ Request Access", "request_access").row();
    }
    return { text, keyboard };
}

async function buildRequestsMenu() {
    const entries = kv.list<UserDetails>({ prefix: ["pending"] });
    const pendingUsers: UserDetails[] = [];
    for await (const entry of entries) pendingUsers.push(entry.value);

    if (pendingUsers.length === 0) {
        return { text: "✅ No pending access requests.", keyboard: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu") };
    }
    
    let text = `<b>Pending Access Requests (${pendingUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    pendingUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n`;
        keyboard.text(`✅ Approve ${user.firstName}`, `approve_${user.id}`).text(`❌ Reject ${user.firstName}`, `reject_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

async function buildWhitelistMenu() {
    const entries = kv.list<UserDetails>({ prefix: ["whitelist"] });
    const whitelistedUsers: UserDetails[] = [];
    for await (const entry of entries) {
        if (typeof entry.value === 'object' && entry.value !== null) {
            whitelistedUsers.push(entry.value);
        }
    }
    
    const keyboard = new InlineKeyboard();

    if (whitelistedUsers.length === 0) {
        const text = "ℹ️ The user whitelist is currently empty.";
        keyboard.text("⬅️ Back to Main Menu", "main_menu");
        return { text, keyboard };
    }

    let text = `<b>Manage Whitelisted Users (${whitelistedUsers.length}):</b>\nThis screen allows you to view and remove existing users.\n\n`;
    whitelistedUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'}) - <code>${user.id}</code>\n`;
        keyboard.text(`🗑️ Remove ${user.firstName}`, `remove_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

function buildClearConfirmationMenu() {
    const text = "⚠️ **DANGER ZONE** ⚠️\n\nAre you sure you want to clear the entire user whitelist?\n\nThis action cannot be undone.";
    const keyboard = new InlineKeyboard()
        .text("🔴 Yes, I am sure. Clear It.", "do_clear_whitelist")
        .row()
        .text("⬅️ No, Go Back to Menu", "main_menu");
    return { text, keyboard };
}


// --- 3. Whitelisting Middleware (Unchanged) ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() === ADMIN_ID) return next();
  if (ctx.callbackQuery) return next(); 

  const command = ctx.message?.text?.split(" ")[0];
  if (command === "/start" || command === "/myid" || command === "/cancel") return next();

  const isWhitelisted = (await kv.get(["whitelist", ctx.from!.id])).value;
  if (isWhitelisted) {
    await next();
  } else {
    await ctx.reply("❌ You are not authorized. Please request access from the main menu.", {
        reply_markup: new InlineKeyboard().text("➡️ Request Access", "request_access")
    });
  }
});


// --- 4. Command and Callback Handlers (Unchanged) ---

bot.command("start", async (ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    const { text, keyboard } = buildMainMenu(isAdmin);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("myid", (ctx) => {
  ctx.reply(`Your Telegram User ID is: \`${ctx.from.id}\``, { parse_mode: "MarkdownV2" });
});

bot.command("cancel", async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    await kv.delete(["conversation_state", ctx.from.id]);
    await ctx.reply("Action cancelled.");
    const { text, keyboard } = buildMainMenu(true);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.on("callback_query:data", async (ctx) => {
    // This entire section is unchanged and correct.
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    if (data === "main_menu") {
        const isAdmin = userId.toString() === ADMIN_ID;
        const { text, keyboard } = buildMainMenu(isAdmin);
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        return await ctx.answerCallbackQuery();
    }

    if (data === "request_access") {
        const user = ctx.from;
        if (user.id.toString() === ADMIN_ID || (await kv.get(["whitelist", user.id])).value) {
            return await ctx.answerCallbackQuery({ text: "✅ You are already authorized.", show_alert: true });
        }
        if ((await kv.get(["pending", user.id])).value) {
            return await ctx.answerCallbackQuery({ text: "⏳ Your request is already pending.", show_alert: true });
        }
        const userDetails: UserDetails = { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username };
        await kv.set(["pending", user.id], userDetails);
        return await ctx.answerCallbackQuery({ text: "✅ Your request has been submitted!", show_alert: true });
    }

    if (userId.toString() !== ADMIN_ID) {
        return await ctx.answerCallbackQuery({ text: "❌ Action not allowed." });
    }

    if (data === "view_requests") {
        const { text, keyboard } = await buildRequestsMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } else if (data === "manage_users") {
        const { text, keyboard } = await buildWhitelistMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } else if (data === "confirm_clear_menu") {
        const { text, keyboard } = buildClearConfirmationMenu();
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } else if (data === "do_clear_whitelist") {
        const entries = kv.list({ prefix: ["whitelist"] });
        let count = 0;
        for await (const entry of entries) {
            await kv.delete(entry.key);
            count++;
        }
        await ctx.editMessageText(`✅ Whitelist cleared. ${count} users have been removed.`, {
            reply_markup: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu")
        });
    } else if (data === "add_user_manual") {
        await kv.set(["conversation_state", userId], "awaiting_user_id");
        await ctx.editMessageText(
            "Please send the Telegram User ID of the person you want to add.\n\n" +
            "They can find their ID by sending /myid to me.\n\n" +
            "Send /cancel at any time to abort.",
            { reply_markup: new InlineKeyboard().text("⬅️ Cancel and Go Back", "main_menu") }
        );
    } else {
        const [action, targetIdStr] = data.split("_");
        const targetId = parseInt(targetIdStr, 10);
        if (!targetId) return await ctx.answerCallbackQuery();

        if (action === "approve") {
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
            await kv.delete(["pending", targetId]);
            await bot.api.sendMessage(targetId, "😔 Your access request has been denied.").catch(console.error);
            await ctx.answerCallbackQuery({ text: "User rejected." });
            const { text, keyboard } = await buildRequestsMenu();
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else if (action === "remove") {
            const removedUser = await kv.get<UserDetails>(["whitelist", targetId]);
            await kv.delete(["whitelist", targetId]);
            await bot.api.sendMessage(targetId, "Your access to this bot has been revoked by the administrator.").catch(console.error);
            await ctx.answerCallbackQuery({ text: `${removedUser.value?.firstName || 'User'} removed.` });
            const { text, keyboard } = await buildWhitelistMenu();
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    }
    await ctx.answerCallbackQuery();
});

// --- 5. Text Message Handler for Admin Conversations [IMPROVED] ---
// We use a regular expression to only trigger this for messages that are purely numbers.
bot.on("message:text", /^\d+$/, async (ctx) => {
    const adminId = ctx.from.id;
    // We only care about the admin in a specific state
    if (adminId.toString() !== ADMIN_ID) return; 
    const state = (await kv.get<string>(["conversation_state", adminId])).value;
    if (state !== "awaiting_user_id") return;

    await kv.delete(["conversation_state", adminId]);

    const targetId = parseInt(ctx.message.text, 10); // We know it's a number

    if (targetId.toString() === ADMIN_ID) {
        await ctx.reply("You can't add yourself, you are the admin!");
        return; // Explicitly return
    }
    const isWhitelisted = (await kv.get(["whitelist", targetId])).value;
    if (isWhitelisted) {
        await ctx.reply("✅ This user is already on the whitelist.");
        return; // Explicitly return
    }
    
    try {
        const chat = await bot.api.getChat(targetId);
        if (chat.type !== "private") {
            await ctx.reply("❌ This ID belongs to a group or channel, not a user.");
            return; // Explicitly return
        }

        const userDetails: UserDetails = {
            id: chat.id,
            firstName: chat.first_name,
            lastName: chat.last_name,
            username: chat.username
        };
        
        await kv.set(["whitelist", targetId], userDetails);
        await ctx.reply(`✅ Success! User <b>${userDetails.firstName}</b> (<code>${userDetails.id}</code>) has been manually added to the whitelist.`, { parse_mode: "HTML" });
        await bot.api.sendMessage(targetId, "🎉 You have been manually granted access to this bot by the administrator!").catch(console.error);
        
        const { text, keyboard } = buildMainMenu(true);
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });

    } catch (error) {
        console.error("Error fetching user for manual add:", error);
        await ctx.reply(`❌ Could not find a user with the ID <code>${targetId}</code>. Please ensure the ID is correct and the user has started this bot at least once.`, { parse_mode: "HTML" });
    }
});


// --- 6. VCF File Processing Logic (Unchanged) ---
bot.on("message:document", async (ctx) => {
    // This entire section is unchanged and correct.
    const doc = ctx.message.document;
    if (!doc.file_name?.toLowerCase().endsWith(".vcf")) {
        return ctx.reply("Please send a valid `.vcf` file.");
    }
    await ctx.reply("⏳ Processing your VCF file...");
    try {
        const file = await ctx.getFile();
        const filePath = file.file_path;
        if (!filePath) throw new Error("File path is not available.");
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
        const fileContent = await response.text();
        const contacts: { name: string, tel: string }[] = [];
        const vcardBlocks = fileContent.split("BEGIN:VCARD");
        for (const block of vcardBlocks) {
            if (block.trim() === "") continue;
            let contactName: string | null = null, contactTel: string | null = null;
            const lines = block.split(/\r?\n/);
            for (const line of lines) {
                if (line.toUpperCase().startsWith("FN:")) contactName = line.substring(line.indexOf(":") + 1).trim();
                else if (!contactName && line.toUpperCase().startsWith("N:")) contactName = line.substring(line.indexOf(":") + 1).replace(/;/g, ' ').trim();
                if (line.toUpperCase().startsWith("TEL")) {
                    const potentialTel = line.substring(line.lastIndexOf(":") + 1).trim();
                    if (potentialTel) contactTel = potentialTel;
                }
            }
            if (contactName && contactTel) contacts.push({ name: contactName, tel: contactTel });
        }
        if (contacts.length === 0) {
            return ctx.reply("Could not find any valid contacts in the file.");
        }
        const rawFileName = doc.file_name || "Untitled.vcf";
        const sanitizedFileName = rawFileName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let message = `<b>File:</b> <code>${sanitizedFileName}</code>\n`;
        message += `<b>Found ${contacts.length} contacts:</b>\n\n`;
        const contactEntries: string[] = [];
        for (const contact of contacts) {
            const sanitizedName = contact.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const sanitizedTel = contact.tel.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            contactEntries.push(`<b>Name:</b> ${sanitizedName}\n<b>Phone:</b> <code>${sanitizedTel}</code>`);
        }
        message += contactEntries.join("\n--------------------\n");
        if (message.length > 4096) {
             await ctx.reply("The contact list is too large to display as a single message.");
        } else {
             await ctx.reply(message, { parse_mode: "HTML" });
        }
    } catch (error) {
        console.error("Error processing VCF file:", error);
        await ctx.reply("An error occurred while processing the file.");
    }
});


// --- 7. Error Handling & Deployment (Unchanged) ---
bot.catch((err) => console.error(`Error for update ${err.ctx.update.update_id}:`, err.error));
if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  Deno.serve(webhookCallback(bot, "std/http"));
} else {
  console.log("Bot starting...");
  bot.start();
}
