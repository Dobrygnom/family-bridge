/** Never substitute a fresh-install snapshot for an unavailable backend. */
export async function loadSavedState<T>(load: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([load(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Saved state unavailable")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
