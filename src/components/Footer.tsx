import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <p className="portal-footer">
      Drogaria Minas Brasil © {new Date().getFullYear()} ·{" "}
      <Link to="/politica-privacidade" className="text-gray-400 font-semibold hover:text-gray-600 transition-colors">
        Política de Privacidade
      </Link>
    </p>
  );
}
