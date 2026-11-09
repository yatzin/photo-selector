import type { FieldHelpMap } from "./types"

export const AI_HELP: FieldHelpMap = {
  "ai.enabled": {
    title: "AI review on",
    what: "Turns AI review on or off for the whole app.",
    use: "When it is off, AI review is not ready to run, and no photos are sent to the model.",
  },
  "ai.base-url": {
    title: "Base URL",
    what: "The address of the server that runs the model. It must speak the OpenAI API, which Ollama, LM Studio and OpenAI do.",
    use: "Photos are sent to this address for review. For Ollama on another PC use http://pc-address:11434/v1.",
  },
  "ai.api-key": {
    title: "API key",
    what: "The password the model server asks for. Local servers usually need none.",
    use: "Stored encrypted on this server and sent with each request. Leave it blank to keep the stored key.",
  },
  "ai.model": {
    title: "Model",
    what: "The name of the model to ask. It has to accept images.",
    use: "Used for every scan. Examples are qwen2.5vl:7b, llava and gpt-4o-mini.",
  },
  "ai.temperature": {
    title: "Temperature",
    what: "How much the model varies its answers. Lower is steadier, higher is more random.",
    use: "Blank uses the server's own default.",
  },
  "ai.max-tokens": {
    title: "Max tokens",
    what: "The most text the model may write back for one request.",
    use: "Blank uses the server's default. Too low can cut an answer off before it finishes.",
  },
  "ai.timeout": {
    title: "Time limit (s)",
    what: "How long to wait for the model to answer one group before giving up.",
    use: "Slow models on big groups need more. Blank is 120 seconds.",
  },
  "ai.extra-body": {
    title: "Extra request JSON",
    what: "Extra settings, written as JSON, added to every request sent to the model.",
    use: 'For server options Photo Selector has no field for, such as {"keep_alive":"10m"} on Ollama.',
  },
  "ai.instructions": {
    title: "What makes a good photo",
    what: "The text that tells the model how to choose the best photo in each group of similar shots.",
    use: "Sent with every group. Reset brings back the built-in text. The reply format below is always added.",
  },
  "ai.screenshot-instructions": {
    title: "What counts as a screenshot",
    what: "The text that tells the model which images are screenshots or other non-photos.",
    use: "Used by Find Screenshots. Photos with camera details, and HEIC files, skip the model.",
  },
  "ai.quality-instructions": {
    title: "What makes a photo bad",
    what: "The text that tells the model which photos are poor, such as blurry, dark or accidental shots.",
    use: "Used by Quality Checks, which looks at every photo in the folder.",
  },
  "ai.group-window": {
    title: "Time window (seconds)",
    what: "The longest gap between two photos that can still be in the same group.",
    use: "Photos taken further apart are never grouped together, however alike they look.",
  },
  "ai.similarity": {
    title: "How similar",
    what: "How alike photos must look to be grouped.",
    values: [
      { label: "Strict", effect: "Only near-identical shots are grouped." },
      { label: "Similar", effect: "Shots of the same scene and moment are grouped." },
      { label: "Loose", effect: "More photos are grouped, including looser matches." },
    ],
  },
  "ai.image-size": {
    title: "Image size sent (pixels)",
    what: "The size of the longest edge of each photo sent to the model.",
    use: "Bigger sees faces and small details better but is slower and costs more.",
  },
  "ai.max-group": {
    title: "Largest group",
    what: "The most photos sent to the model in one group.",
    use: "A longer burst of shots is split into chunks of this size.",
  },
  "ai.start-fresh": {
    title: "Start fresh",
    what: "Checks every photo again, even ones already checked in an earlier scan.",
    use: "Off by default, so a repeat scan only looks at new photos. Turn it on after changing the instructions or the model.",
  },
}
