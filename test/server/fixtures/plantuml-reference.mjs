// Reference PlantUML diagrams for the review app's diagram theming.
// REFERENCE sets no colors, so everything the vendored runtime paints for it is a default color; AUTHORED sets colors an author might choose.

export const REFERENCE = Object.freeze({
  sequence: ["@startuml", "actor Caller", "participant Service", "Caller -> Service : request", "alt timed out", "Service --> Caller : retry", "end", "note right of Caller : waits", "== deadline ==", "@enduml"],
  class: ["@startuml", "class Policy {", "  +deadline: int", "}", "interface Strategy", "Policy ..|> Strategy", "package retry {", "  class Backoff", "}", "note \"bounded\" as N1", "@enduml"],
  component: ["@startuml", "component Client", "[Gateway] --> Client", "node Host {", "  [Worker]", "}", "database Store", "cloud Remote", "Client --> Store", "@enduml"],
  activity: ["@startuml", "start", ":attempt;", "if (timed out?) then (yes)", "  :wait;", "else (no)", "  :return;", "endif", "stop", "@enduml"],
  error: ["@startuml", "A -> ", "@enduml"]
});

export const AUTHORED = Object.freeze({
  // A pink node, a dark red arrow with a dark red label on the paper, and a plain node beside them.
  colored: ["@startuml", "rectangle Plain", "rectangle Pink #FFC0CB", "Plain -[#8B0000]-> Pink : <color:#5A0000>authored label</color>", "@enduml"]
});
