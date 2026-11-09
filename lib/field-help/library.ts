import type { FieldHelpMap } from "./types"

export const LIBRARY_HELP: FieldHelpMap = {
  "send.action": {
    title: "Action",
    what: "Whether the chosen files leave where they are or stay there too.",
    values: [
      { label: "Move", effect: "The files go to the new folder and are gone from the old one." },
      { label: "Copy", effect: "The files are copied. The originals stay where they are." },
    ],
  },
  "send.user": {
    title: "User",
    what: "Whose folder the files go into.",
    use: "The files land in a folder named after that person. They see them on their own pages.",
  },
  "send.details": {
    title: "Details",
    what: "A note for the person who gets the files.",
    use: "Saved with the files as a note they can read. Up to 4000 characters.",
  },
  "users.role": {
    title: "Role",
    what: "What this person may do in the app.",
    values: [
      { label: "Admin", effect: "Sorts photos and also manages users and storage." },
      { label: "User", effect: "Sorts photos." },
    ],
  },
}
