import core from "./worker-clean.js";

export default {
  async fetch(request, env, ctx) {
    return core.fetch(request, env, ctx);
  }
};
