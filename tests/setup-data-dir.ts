// An operator's shell may point at a running bot's data directory. Legacy tests
// isolate through HOME, so an inherited override must not bypass that isolation.
// Tests using BLACKDOGBOT_DATA_DIR opt into their own temporary path explicitly.
delete process.env.BLACKDOGBOT_DATA_DIR;
