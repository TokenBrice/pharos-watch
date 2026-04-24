"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface FilterSearchInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className: string;
  inputClassName: string;
}

export function FilterSearchInput({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  className,
  inputClassName,
}: FilterSearchInputProps) {
  return (
    <div className={className}>
      <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={inputClassName}
        aria-label={ariaLabel}
      />
    </div>
  );
}
