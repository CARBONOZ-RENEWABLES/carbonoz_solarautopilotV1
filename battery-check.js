import mqtt from "mqtt";

const client = mqtt.connect({
  host: "homeassistant-andreas-raspberry.zebu-beaufort.ts.net",
  port: 1883,
  username: "Elite",
  password: "jHIJES529hhWWjjIsyS",
});

client.on("connect", () => {
  console.log("✅ Connected – listening to all Solar Assistant topics...");
  client.subscribe("solar_assistant/#");
});

client.on("message", (topic, message) => {
  console.log(`${topic} => ${message.toString()}`);
});

client.on("error", (err) => {
  console.error("❌ MQTT Error:", err.message);
});
