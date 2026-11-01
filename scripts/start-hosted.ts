import "dotenv/config";
import { hostedSettings } from "../server/hosting";

Object.assign(process.env, hostedSettings(process.env));
await import("../server/index");
