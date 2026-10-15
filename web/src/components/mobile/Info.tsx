import type { ReactNode } from "react";
import { create } from "zustand";
import { UnstyledButton } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { Sheet } from "./Sheet";

// One definition sheet for the whole phone shell; every Info opens it.
const useDef = create<{ title: ReactNode; text: ReactNode; open: boolean }>(() => ({ title: "", text: "", open: false }));

/** Open the definition sheet from code (e.g. a figure's own tap handler). */
export const showInfo = (title: ReactNode, text: ReactNode) => useDef.setState({ title, text, open: true });

/**
 * A label that opens its definition: the phone's stand-in for the desktop's hover titles. With children, the
 * label itself is the button and a dotted underline marks it as defined; without, a bare ⓘ (only where there
 * is no label to tap). Reuse the desktop's tip text.
 */
export function Info({ title, text, children }: { title: ReactNode; text: ReactNode; children?: ReactNode }) {
  return (
    <UnstyledButton
      className={"m-info" + (children == null ? " icon" : "")}
      onClick={(e) => {
        e.stopPropagation(); // inside a tappable row, the label explains and the row navigates
        showInfo(title, text);
      }}
      aria-label={children == null && typeof title === "string" ? `What is ${title}?` : undefined}
      aria-haspopup="dialog"
    >
      {children ?? <IconInfoCircle size={16} stroke={1.75} />}
    </UnstyledButton>
  );
}

/** A label that opens its definition when there is one (dotted underline), else the plain label. */
export function InfoLabel({ label, info }: { label: ReactNode; info?: ReactNode }) {
  if (info == null || info === "") return <>{label}</>;
  return (
    <Info title={label} text={info}>
      <span className="m-defined">{label}</span>
    </Info>
  );
}

/** The same dotted label without its own button, for rows whose whole area opens the definition. */
export function DefinedLabel({ label, info }: { label: ReactNode; info?: ReactNode }) {
  return info == null || info === "" ? <>{label}</> : <span className="m-defined">{label}</span>;
}

/** Props that make a whole row open a definition (role, keyboard, click), or nothing when there is none. */
export function defineProps(title: ReactNode, info: ReactNode | undefined) {
  if (info == null || info === "") return {};
  const open = () => showInfo(title, info);
  return {
    role: "button",
    tabIndex: 0,
    "aria-haspopup": "dialog" as const,
    onClick: open,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
  };
}

/** Mounted once by the shell. */
export function InfoSheet() {
  const { title, text, open } = useDef();
  return (
    <Sheet opened={open} onClose={() => useDef.setState({ open: false })} title={title} above>
      <div className="m-def">{typeof text === "string" ? text.split("\n\n").map((p, i) => <p key={i}>{p}</p>) : text}</div>
    </Sheet>
  );
}
