import Firecrawl from "@mendable/firecrawl-js";

export const firecrawl = process.env.FIRECRAWL_API_KEY
  ? new Firecrawl({
    apiKey: process.env.FIRECRAWL_API_KEY,
  })
  : null;

