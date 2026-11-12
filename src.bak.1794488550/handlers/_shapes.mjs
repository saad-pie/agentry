// agentry/src/handlers/_shapes.mjs
//
// v0.15.29 — capability shapes.
//
// A shape is a skeleton of steps for a capability kind. It contains
// NO code and NO reference implementation. It names the verbs a
// capability of that kind typically needs, why each exists, what it
// consumes, and what commonly fails at that step.
//
// The synthesizer hands a shape to the model and asks it to fill each
// slot for the specific gap. Without a reference handler to copy,
// there is no anchor to stretch. Every capability that lands in the
// graph is written from the shape, not from a previous synthesis.

export const SHAPES = {
  bua: {
    description: "Browser automation. Open a real browser, navigate, act, capture, emit.",
    steps: [
      { verb: "launch",   why: "Open a browser instance. The binary dependency is declared in requires.post_install.", fails_if: "browser binary missing or sandbox blocks launch", produces: "browser handle" },
      { verb: "navigate", why: "Load the target URL and wait for the page to be ready.", fails_if: "URL unreachable, site blocks headless, or page never becomes ready", produces: "loaded page" },
      { verb: "act",      why: "Interact with the page: click, fill, evaluate, wait for a specific selector.", fails_if: "element missing, hidden behind an overlay, or the action times out", produces: "mutated page state" },
      { verb: "capture",  why: "Extract the caller's target: PNG bytes, HTML, text, or a specific element.", fails_if: "capture target offscreen or format unsupported", produces: "captured artifact" },
      { verb: "emit",     why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  cua: {
    description: "Computer use. Perceive screen state, decide an action, act, verify.",
    steps: [
      { verb: "perceive", why: "Read the current screen state: screenshot, accessibility tree, or DOM.", fails_if: "screen grab fails or the process has no display access", produces: "observation" },
      { verb: "decide",   why: "Choose the next action from the observation and the goal.", fails_if: "observation ambiguous or goal unreachable from the current state", produces: "chosen action" },
      { verb: "act",      why: "Execute the input: click coordinates, type, press keys, move mouse.", fails_if: "target coordinates stale or input blocked", produces: "executed action" },
      { verb: "verify",   why: "Re-read screen state and confirm the action had the intended effect.", fails_if: "state did not change as expected", produces: "verification result" },
      { verb: "emit",     why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  mua: {
    description: "Mobile use. Connect to a device, locate, interact, capture.",
    steps: [
      { verb: "connect",   why: "Establish a session with the target device or emulator.", fails_if: "no device reachable or driver not installed", produces: "device session" },
      { verb: "locate",    why: "Find the elements the task needs to interact with.", fails_if: "element not present in the current view or selector is wrong", produces: "target elements" },
      { verb: "interact",  why: "Perform the touch, tap, swipe, or text input the task needs.", fails_if: "gesture blocked or target obscured", produces: "mutated UI state" },
      { verb: "capture",   why: "Take a screenshot, extract text, or read the current UI tree.", fails_if: "capture target not visible", produces: "captured artifact" },
      { verb: "emit",      why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  memory: {
    description: "Memory. Open a store, perform encode/retrieve/rank, shape, emit.",
    steps: [
      { verb: "connect", why: "Open the backing store: filesystem, vector DB, or remote API.", fails_if: "store unreachable or credentials wrong", produces: "store handle" },
      { verb: "operate", why: "Encode (write), retrieve (read), or rank (search + score) as the capability promises.", fails_if: "query malformed or store empty", produces: "primary operation result" },
      { verb: "shape",   why: "Transform the raw result into the output fields promised in produces.", fails_if: "store returned a shape different than expected", produces: "shaped output" },
      { verb: "emit",    why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  web: {
    description: "Web fetch and parse.",
    steps: [
      { verb: "fetch", why: "HTTP request the target URL with the headers the site requires.", fails_if: "site unreachable, rate limited, or blocks the user-agent", produces: "raw response body" },
      { verb: "parse", why: "Parse the response (JSON, HTML, XML) and extract the promised fields.", fails_if: "response shape differs or parse target missing", produces: "parsed structure" },
      { verb: "emit",  why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  tool: {
    description: "Generic tool. Prepare, execute, emit.",
    steps: [
      { verb: "prepare", why: "Validate inputs and set up resources: files, sessions, connections.", fails_if: "required input missing or a prerequisite is absent", produces: "ready state" },
      { verb: "execute", why: "Perform the actual operation this capability is named for.", fails_if: "operation raises, times out, or produces unexpected output", produces: "operation result" },
      { verb: "emit",    why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  notify: {
    description: "Notify. Compose, deliver, emit.",
    steps: [
      { verb: "compose", why: "Build the message body from inputs: subject, markdown, recipient.", fails_if: "required message fields missing", produces: "composed message" },
      { verb: "deliver", why: "Send via the provider's API or transport.", fails_if: "auth fails, rate limited, or the provider rejects the message", produces: "provider response" },
      { verb: "emit",    why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  agent_skill: {
    description: "Wrap an agent SKILL.md as a capability. The skill's instructions become the system prompt; the caller's input becomes the user message. The skill produces structured JSON.",
    steps: [
      { verb: "load_skill", why: "Verify the SKILL.md content is present and parse its frontmatter (name, description).", fails_if: "SKILL.md missing, malformed, or empty", produces: "parsed skill metadata" },
      { verb: "invoke_llm", why: "Send the skill instructions + caller input to the LLM and get a structured JSON response.", fails_if: "LLM call fails, rate limited, or returns content that is not valid JSON", produces: "parsed JSON response" },
      { verb: "emit", why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  },
  default: {
    description: "Unknown kind. Reason about what this specific capability needs.",
    steps: [
      { verb: "prepare", why: "What does this capability need to set up before it can act?", fails_if: "environment lacks a prerequisite or an input is malformed", produces: "ready state" },
      { verb: "execute", why: "What is the single core action this capability performs?", fails_if: "core action fails or produces unexpected output", produces: "core result" },
      { verb: "post",    why: "What post-processing, cleanup, or verification does the result need?", fails_if: "cleanup fails or result incomplete", produces: "final result" },
      { verb: "emit",    why: "Write ONE JSON object to stdout with exactly the fields promised in produces.", fails_if: "malformed JSON or a promised field is undefined", produces: "stdout JSON" }
    ]
  }
};

export function getShape(kind) {
  return SHAPES[kind] || SHAPES.default;
}

export function listShapeKinds() {
  return Object.keys(SHAPES);
}
