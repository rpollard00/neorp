import type { APIRoute, GetStaticPaths } from "astro";
import { drawPlate, plateFor } from "../../lib/plates";
import { getPublishedPosts, getUnpublishedPosts } from "../../utils/posts";

export const getStaticPaths = (async () => {
  const now = new Date();
  const posts = [
    ...(await getPublishedPosts(now)),
    ...(import.meta.env.DEV
      ? (await getUnpublishedPosts(now)).map(({ post }) => post)
      : []),
  ];
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
