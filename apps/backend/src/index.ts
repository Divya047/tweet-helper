import { buildServer } from "./server.js";

const built = await buildServer();

try {
  await built.app.listen({ host: built.config.host, port: built.config.port });
  built.app.log.info(`Tweet Helper backend listening on http://${built.config.host}:${built.config.port}`);
} catch (error) {
  built.app.log.error(error);
  process.exit(1);
}
