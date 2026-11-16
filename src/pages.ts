export interface Page<T> {
  data: T[];
  next_cursor?: string | null | undefined;
  has_more: boolean;
}

/** Walk every item of a cursor-paginated list. */
export async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* page.data;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}
