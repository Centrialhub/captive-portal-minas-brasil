import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <p className="portal-footer">
      Drogaria Minas Brasil © {new Date().getFullYear()} ·{" "}
      <Link to="/sobre" style={{ color: "#bbb" }}>
        Sobre
      </Link>{" "}
      ·{" "}
      <Link to="/politica-privacidade" style={{ color: "#bbb" }}>
        Política de Privacidade
      </Link>
    </p>
  );
}
