export const telegramCommands = [
  { command: "start", description: "See what the bot can do" },
  { command: "help", description: "See commands and examples" },
  { command: "remind", description: "Create a one-time reminder" },
  { command: "schedules", description: "List your pending schedules" },
  { command: "edit_schedule", description: "Change a pending schedule by ID" },
  {
    command: "delete_schedule",
    description: "Cancel a pending schedule by ID",
  },
  { command: "timezone", description: "See or set your scheduling timezone" },
  { command: "remember", description: "Save a preference" },
  { command: "memories", description: "List your saved preferences" },
  { command: "forget", description: "Remove a saved preference" },
  { command: "clear_preferences", description: "Remove all saved preferences" },
];

export const telegramWelcome = [
  "Hi! Ask me a question, set a reminder, or schedule a weather update here.",
  "Try “Remind me to call Dad tomorrow at 6 pm” or “Send me the weather in Mumbai tomorrow at 8 am.” Tap Approve to schedule it.",
  "Set your local time with /timezone Europe/London (use your own timezone). See /help for the full list of commands.",
].join("\n\n");

export const telegramHelp = [
  "Ask a question in plain text, or try “What’s the weather in Mumbai?” Weather and scheduling requests show an approval prompt.",
  "/remind call Dad tomorrow at 6 pm — create a one-time reminder.",
  "/schedules — list pending reminders and weather updates. Use /schedules 2 for page 2.",
  "/edit_schedule ID tomorrow at 7 pm — change the time. You can also change the reminder text or weather city. Use an ID from /schedules and approve the change.",
  "/delete_schedule ID — cancel a pending delivery.",
  "/timezone Europe/London — save your timezone. Send /timezone to see which zone is in use.",
  "/remember weather city = Mumbai, India — save a preference.",
  "/memories — list saved preferences. /forget weather city removes one, and /clear_preferences removes all saved preferences.",
  "The bot uses recent chat messages for context. Saved preferences and schedules are specific to this private chat.",
  "AI replies use OpenAI. Approved weather lookups send the requested city to OpenWeatherMap.",
].join("\n\n");
