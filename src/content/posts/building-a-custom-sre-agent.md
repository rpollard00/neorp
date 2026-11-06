---
title: "Building a custom SRE agent"
description: "A bespoke site-reliability agent built with pi-durable"
pubDate: 2026-11-05
tags: ["ai", "pi", "effect", "typescript", "foldkit"]
---

I had the (probably unoriginal) idea to build an SRE agent for monitoring the production billing application that I’ve built over the last few months,  as its userbase has expanded to the entire company.

I ran into some organizational friction pretty early on in trying to set something up. We have no organizational precedent for something like this -- so any integration, even connecting it to Teams as a bot, is going to require a bunch of nonsense. 

Since I didn't have anything beyond a vision, and Enterprises love concrete requirements, forms, and diagrams, I decided to just build it, using my Codex account for inference and my existing permissions for access. The risk with my permissions is that I can do a lot of things that you probably don't want an agent doing. Especially one that's under active development. However, there’s a solid solution to this. I can keep the agent constrained by giving it specific tools rather than letting it run wild with bash and direct access to Azure. It’s currently just acting as an extension of me, and has not been extended any write access to production.

My initial idea was to integrate into Teams, and have that be the main point of interaction with the agent. However, at my company, there’s no defined process to integrate a custom bot into Teams, apparently nobody has ever done this before. For now, I decided to just put together a chat web UI while in the early Skunkworks/POC phase.

## Tech Stack

We're using [Pi-Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). This is the foundation, pi-durable, is an SDK on top of Pi that gives us a great set of components for building an agent with a durable harness. We are using [Effect](https://effect.website/) everywhere, and [Foldkit](https://foldkit.dev/) on the frontend. 

I’m using Luna 6 Max for inference - it’s slow as hell, but it’s also cheap as hell, and nobody has turned the 6.1 Terra token faucet on, so I can't use that. The downside with Luna is that it is somewhat stupid and frustrating to talk to.

## Tools

I’ve been building basic guidance into the harness on how to operate. I’ve been adding skills, and giving the agent read-only tools to look at metrics, signals, and logs. These are the ONLY tools the agent can use. It absolutely cannot use a shell, or cli tools. Thus far, it has 40 different tools that let it read certain database records, app insights logs, retrieve metrics, interact with ADO boards, and read application code.

The agent checks various signals every hour, and if anomalies are raised then it can launch subagents within its harness to perform asynchronous investigation. It will track anomalies across multiple intervals. It has a tool to work its own internal issue log for tracking and follow-up, and if there are real issues identified it can create work items in Azure DevOps. For now, it does not directly integrate with any coding agents, but it does have tools that let it read the code for the application repository, so it can correlate log and failure data.

## It’s Alive!

Once I fired it up, it was useful almost immediately. Identifying some 500 errors in the logs, and creating tickets for those, which I was able to hand off to coding agents and land fixes for. It also identified a couple of performance issues that were easy wins.

It was super annoying though. It started opening ADO tickets for new tools for its harness rather than just for app issues (put a stop to that really fast). It did not act like a team member, or maybe it acted like your most annoying team member, narrating everything it was looking at, and constantly asking for help. 

My iteration loop to improve that has been to tune its instructions to take the most annoying bits out, and make it more conversational. I added a skills reader to the harness, and writing skills like my customized version of unslop. When there are gaps in what it can monitor (it complains), I create new tools that allow it new read access, and pi durable means I can just build and relaunch and it’ll pick back up where it was, now with better tools! It has also been helpful to just ask it what it could use to monitor more effectively, and build tools based on that.

## Now What?

I plan on continuing to iterate and refine the agent, it’s already shown value for this application. I’ll get it deployed somewhere so that it can be always on, where my team can interact with it. I’d like to integrate the chat with Teams, but I actually think the web UI might prove to be useful to continue to introspect what the agent is doing. The other missing piece is giving it a way to actually land fixes, but I have yet not decided on the exact approach I want to take.
