import { useState } from "react";
import { Button, Modal } from "@mantine/core";

const SEEN = "bndesk-demo-notice";
const CONTACT = "ziyang.liu.r@outlook.com";

/** Shown once per browser session on the mock build: the figures are simulated. */
export function DemoNotice() {
  const [open, setOpen] = useState(() => sessionStorage.getItem(SEEN) == null);
  const close = () => {
    sessionStorage.setItem(SEEN, "1");
    setOpen(false);
  };
  return (
    <Modal
      opened={open}
      onClose={close}
      centered
      size={420}
      title="Simulated data"
      classNames={{
        content: "demo-notice",
        header: "demo-notice",
        title: "demo-notice-title",
      }}
    >
      <p className="demo-notice-body">
        This demo runs in your browser on generated accounts, orders and fills.
        Nothing here is a real account or real P&amp;L.
      </p>
      <p className="demo-notice-body">
        For a walkthrough of the dashboard on live accounts, write to{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
      <Button
        size="xs"
        variant="default"
        onClick={close}
        mt="sm"
        data-autofocus
      >
        View the demo
      </Button>
    </Modal>
  );
}
