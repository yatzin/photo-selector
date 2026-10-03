"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { scanNow } from "@/lib/worker-server"

export async function rescanAction() {
  const session = await auth()
  if (!session || session.user.role !== "ADMIN") redirect("/")
  void scanNow()
  revalidatePath("/settings")
}
