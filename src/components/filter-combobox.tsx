"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface FilterComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  label: string;
  searchable?: boolean;
  emptyLabel?: string;
  triggerClassName?: string;
}

export function FilterCombobox({
  value,
  onValueChange,
  options,
  placeholder,
  label,
  searchable = true,
  emptyLabel = "No results",
  triggerClassName,
}: FilterComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((opt) => opt.value === value);
  const display = selected?.label ?? placeholder ?? "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "pharos-focus-ring inline-flex items-center gap-1.5",
            triggerClassName ?? "pharos-control-pill text-xs",
          )}
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="text-foreground">{display}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          {searchable ? <CommandInput placeholder={`Search ${label.toLowerCase()}…`} /> : null}
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.label}
                onSelect={() => {
                  onValueChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
