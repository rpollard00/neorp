import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { drawPlate, plateFor } from "../../lib/plates";

export const getStaticPaths = (async () => {
  const posts = await getCollection("posts");
  return posts.map((post) => {
    const { palette, seed } = plateFor(post);
    return { params: { slug: post.id }, props: { palette, seed } };
  });
}) satisfies GetStaticPaths;

type Props = Pick<ReturnType<typeof plateFor>, "palette" | "seed">;

export const GET: APIRoute<Props> = ({ props }) =>
  new Response(drawPlate(props), {
    headers: { "Content-Type": "image/png" },
  });
