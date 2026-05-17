export type PharosTone = "brand" | "data" | "insight" | "classification" | "neutral";

export function getPharosToneClasses(tone: PharosTone) {
  switch (tone) {
    case "brand":
      return {
        border: "border-l-frost-blue",
        kicker: "text-sky-700 dark:text-frost-blue/82",
        icon: "text-sky-700 dark:text-frost-blue/82",
        rule: "from-frost-blue/35 to-transparent",
      };
    case "data":
      return {
        border: "border-l-amber-500",
        kicker: "text-amber-700 dark:text-amber-400",
        icon: "text-amber-700 dark:text-amber-400",
        rule: "from-amber-500/35 to-transparent",
      };
    case "insight":
      return {
        border: "border-l-emerald-500",
        kicker: "text-emerald-700 dark:text-emerald-400",
        icon: "text-emerald-700 dark:text-emerald-400",
        rule: "from-emerald-500/35 to-transparent",
      };
    case "classification":
      return {
        border: "border-l-violet-500",
        kicker: "text-violet-700 dark:text-violet-400",
        icon: "text-violet-700 dark:text-violet-400",
        rule: "from-violet-500/35 to-transparent",
      };
    default:
      return {
        border: "border-l-zinc-500",
        kicker: "text-muted-foreground",
        icon: "text-muted-foreground",
        rule: "from-border to-transparent",
      };
  }
}
