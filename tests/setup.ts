import "@testing-library/jest-dom/vitest";

process.env.FILM_EXTERNAL_LINK_ORIGINS = "http://localhost,http://localhost:3000,http://127.0.0.1:3000";
process.env.FILM_DEFAULT_EXTERNAL_LINK_ORIGIN = "http://localhost:3000";
process.env.FILM_MAIL_SENDER_EMAIL = process.env.FILM_MAIL_SENDER_EMAIL || "workflow-sender@example.test";
