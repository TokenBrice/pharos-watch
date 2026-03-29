import { logosById } from "@/lib/logos";

const RESULT = { data: logosById };

export function useLogos() {
  return RESULT;
}
